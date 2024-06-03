import * as github from '@actions/github'
import * as core from '@actions/core'
import * as githubUtils from '@actions/github/lib/utils'
import * as retry from '@octokit/plugin-retry'
import {RequestError} from '@octokit/request-error'
import {ConfigurationOptions} from './schemas'

const retryingOctokit = githubUtils.GitHub.plugin(retry.retry)
const octo = new retryingOctokit(
  githubUtils.getOctokitOptions(core.getInput('repo-token', {required: true}))
)

// Comment Marker to identify an existing comment to update, so we don't spam the PR with comments
const COMMENT_MARKER = '<!-- dependency-review-pr-comment-marker -->'
const MAX_COMMENT_LENGTH = 65536

export async function commentPr(
  summary: typeof core.summary,
  config: ConfigurationOptions,
  minComment: string
): Promise<void> {
  const commentContent = summary.stringify()

  // this should be truncated for us if it's too long but
  // we could check len and sub in minSummary instead
  core.setOutput('comment-content', commentContent)

  if (
    !(
      config.comment_summary_in_pr === 'always' ||
      (config.comment_summary_in_pr === 'on-failure' &&
        process.exitCode === core.ExitCode.Failure)
    )
  ) {
    return
  }

  if (!github.context.payload.pull_request) {
    core.warning(
      'Not in the context of a pull request. Skipping comment creation.'
    )
    return
  }

  let commentBody = `${commentContent}\n\n${COMMENT_MARKER}`

  if (commentBody.length >= MAX_COMMENT_LENGTH) {
    core.debug(
      'The comment was too big for the GitHub API. Falling back on a minimum comment'
    )
    commentBody = `${minComment}\n\n${COMMENT_MARKER}`
  }

  try {
    const existingCommentId = await findCommentByMarker(COMMENT_MARKER)

    if (existingCommentId) {
      await octo.rest.issues.updateComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id: existingCommentId,
        body: commentBody
      })
    } else {
      await octo.rest.issues.createComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: github.context.payload.pull_request.number,
        body: commentBody
      })
    }
  } catch (error) {
    if (error instanceof RequestError && error.status === 403) {
      core.warning(
        `Unable to write summary to pull-request. Make sure you are giving this workflow the permission 'pull-requests: write'.`
      )
    } else {
      if (error instanceof Error) {
        core.warning(
          `Unable to comment summary to pull-request, received error: ${error.message}`
        )
      } else {
        core.warning(
          'Unable to comment summary to pull-request: Unexpected fatal error'
        )
      }
    }
  }
}

async function findCommentByMarker(
  commentBodyIncludes: string
): Promise<number | undefined> {
  const commentsIterator = octo.paginate.iterator(
    octo.rest.issues.listComments,
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      // We are already checking if we are in the context of a pull request in the caller
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      issue_number: github.context.payload.pull_request!.number
    }
  )

  for await (const {data: comments} of commentsIterator) {
    const existingComment = comments.find(comment =>
      comment.body?.includes(commentBodyIncludes)
    )
    if (existingComment) return existingComment.id
  }

  return undefined
}

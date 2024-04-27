// Name: Git Repo Explorer
// Keyword: repo

// noinspection JSArrowFunctionBracesCanBeRemoved
import '@johnlindquist/kit'
import { join } from 'path'
import { authenticate } from '@johnlindquist/kit/api/kit'
import { Choice } from '../../../../.kit'

const { Octokit }: typeof import('@octokit/rest') = await npm('@octokit/rest')

type RepoInfo = {
  owner: string
  repo: string
  description: string
}

const data = await db({ recentRepos: [] as RepoInfo[] })

if (!process.env.GITHUB_SCRIPTKIT_TOKEN) {
  await authenticate()
}

const octokit = new Octokit({ auth: await env('GITHUB_SCRIPTKIT_TOKEN') })

async function buildRepoChoices(input: string) {
  const cachedResults = data.recentRepos.map((value) => ({
    name: `https://github.com/${value.owner}/${value.repo}`,
    description: value.description,
    value: value,
    actions: [
      {
        name: 'Remove from recents',
        onAction: async () => {
          data.recentRepos.splice(data.recentRepos.indexOf(value), 1)
          await data.write()
          setChoices(await buildRepoChoices(input))
        },
      },
    ],
  }))

  if (input.trim() === '') {
    return cachedResults
  }

  const repoSearch = await octokit.rest.search.repos({
    q: input,
    sort: 'stars',
  })

  const searchResults = repoSearch.data.items.map((x) => ({
    name: `${x.owner.html_url}/${x.name}`,
    description: x.description,
    value: { owner: x.owner.login, repo: x.name } as RepoInfo,
  }))

  return [...searchResults, ...cachedResults].map(
    (c) =>
      ({
        ...c,
        preview: async () => md(await downloadFileText(c.value.owner, c.value.repo, 'README.md')),
      }) as Choice,
  )
}

const repoInfo = await arg<RepoInfo>({
  placeholder: 'Search Repository',
  choices: buildRepoChoices,
})

const { owner, repo } = repoInfo
if (!data.recentRepos.find((x) => x.repo === repo && x.owner === owner)) {
  data.recentRepos.push(repoInfo)
}
await data.write()

const repoId = `${owner}/${repo}`
const formatRepoUrl = (path: string) => `https://github.com/${repoId}${path}`

async function downloadFileText(owner: string, repo: string, pathFromRoot: string) {
  const response = await octokit.repos.getContent({ owner, repo, path: pathFromRoot })
  return Buffer.from((response.data as { content: string }).content, 'base64').toString()
}

onTab(`${owner}/${repo}`, async (input) => {
  const readmeMd = await downloadFileText(owner, repo, 'README.md')

  // await arg({
  //   placeholder: 'README',
  //   panel: md(readmeMd),
  //   choices: [{ name: 'test' }],
  // });

  await arg(
    {
      placeholder: 'README',
      actions: [
        {
          name: 'Open',
          flag: 'open',
          visible: true,
          shortcut: 'ctrl+o',
          onAction: () => {
            open(`https://github.com/${owner}/${repo}`)
          },
        },
        {
          name: 'Clone',
          flag: 'clone',
          visible: true,
          shortcut: 'ctrl+c',
          onAction: async () => {
            const cloneTo = await selectFolder('Clone to...')
            await degit(`https://github.com/${owner}/${repo}`).clone(join(cloneTo, repo))
          },
        },
      ],
    },
    md(readmeMd),
  )
})

onTab(`General`, async (input) => {
  const readmeMd = await downloadFileText(owner, repo, 'README.md')
})

onTab('File Search', async () => {
  const repoInfo = await octokit.rest.repos.get({
    owner,
    repo,
  })

  let branch = repoInfo.data.default_branch

  const allFilesResponse = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1', {
    owner,
    repo,
    tree_sha: branch,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  await arg(
    {
      placeholder: 'Search Files',
      actions: [
        {
          // TODO: not working properly
          name: 'Choose branch',
          visible: true,
          onAction: async () => {
            branch = await arg('Branch name')
          },
        },
      ],
    },
    async (input) => {
      const choices = allFilesResponse.data.tree
        .filter((x) => x.path.includes(input))
        .map((x) => ({
          group: 'File Results',
          name: x.path,
          onSubmit: () => {
            open(formatRepoUrl(`/blob/main/${x.path}`))
          },
        }))

      // const filteredFiles = [];
      // (await createChoiceSearch(fileResults, {}))(input).forEach((scoredChoice) =>
      //   filteredFiles.push(scoredChoice as unknown as Choice),
      // );

      // inspect(choices);

      return groupChoices(choices)
    },
  )
})

onTab('Code Search', async () => {
  await arg('Search Files', async (input) => {
    if (input.trim() === '') {
      return []
    }
    const searchResults = await octokit.rest.search.code({
      q: `${input}+in:file+repo:${repoId}`,
      headers: { Accept: 'application/vnd.github.text-match+json' },
    })

    // TODO: setScoredChoices any good?
    const choices = searchResults.data.items.map((x) => ({
      group: 'Code Search Results',
      name: x.path,
      html: x.text_matches[0] ? formatTextMatchHTML(x.text_matches[0], true) : x.path,
      actions: [{ name: 'Action 1' }, { name: 'Action 2', value: ' a value' }],
      preview: () =>
        x.text_matches.map((x) => formatTextMatchHTML(x)).join('\n<span style="color: green;">=====</span>'),
    }))

    return choices
  })
})

function formatTextMatchHTML(
  textMatch: {
    object_url?: string
    object_type?: string | null
    property?: string
    fragment?: string
    matches?: {
      text?: string
      indices?: number[]
    }[]
  },
  onlyMatchLine: boolean = false,
): string {
  try {
    const { fragment, matches } = textMatch

    // If no fragment or matches are provided, return the original fragment or an empty string
    if (!fragment || !matches || matches.length === 0) {
      return fragment || ''
    }

    // Split the fragment into lines
    const lines = fragment.split('\n')

    let parts = []
    if (onlyMatchLine) {
      // Sort matches by starting index to handle them in order in a single pass

      matches.sort((a, b) => a.indices[0] - b.indices[0])

      // This array will hold parts of the final HTML string for the line with the match
      let found = false

      // Iterate over each match and process only the line containing the match
      matches.forEach((match) => {
        const start = match.indices[0]
        const end = match.indices[1]

        // Determine which line the match is on
        let lineStart = 0
        let lineEnd = 0
        let lineIndex = 0

        for (let i = 0; i < lines.length; i++) {
          lineEnd = lineStart + lines[i].length // Adjust lineEnd to the end of the current line

          if (start >= lineStart && start <= lineEnd) {
            lineIndex = i
            break
          }

          lineStart = lineEnd + 1 // Move to the next line start, accounting for the newline character
        }

        // If the match is found on the line, highlight it and prepare the result
        if (!found) {
          const lineContent = lines[lineIndex]
          const relativeStart = start - lineStart
          const relativeEnd = end - lineStart

          parts.push(lineContent.substring(0, relativeStart))
          parts.push(
            `<span style="background-color: rgba(235, 228, 194, 0.7); box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.2); padding: 2px 4px;">${lineContent.substring(
              relativeStart,
              relativeEnd + 1,
            )}</span>`,
          )
          parts.push(lineContent.substring(relativeEnd + 1))

          found = true
        }
      })
    } else {
      // This array will hold parts of the final HTML string
      let currentIndex = 0

      // Iterate over sorted matches and build the HTML string
      matches.forEach((match, index) => {
        const start = match.indices[0]
        const end = match.indices[1]
        const matchText = match.text || ''

        // Add the text before the match
        parts.push(fragment.substring(currentIndex, start))
        // Add the highlighted match
        parts.push(
          `<span style="background-color: rgba(235, 228, 194, 0.7); box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.2); padding: 2px 4px;">${fragment.substring(
            start,
            end + 1,
          )}</span>`,
        )

        // Update the currentIndex to be the end of the current match
        currentIndex = end + 1
      })

      // Add any remaining text after the last match
      parts.push(fragment.substring(currentIndex))
    }

    const result = parts.length > 0 ? parts.join('') : ''
    return `<pre>${result}</pre>`
  } catch (err) {
    console.error(err)
    return `<pre>Cannot render!</pre>`
  }
}

// const choice = await micro('Script Kit Docs', groupChoices([
//     { name: 'Docs', group: 'Local', onSubmit: () => open('http://localhost:3000') },
//     {
//       name: 'JS User API',
//       group: 'GitHub',
//       onSubmit() {
//         open('https://github.com/johnlindquist/kit/tree/main/src/api');
//       },
//     },
//   ]));

const MAX_LENGTH = 2_048;
const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i;
const GITLAB_MR = /^https?:\/\/[^/]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#]|$)/i;
const BITBUCKET_PR = /^https?:\/\/(?:www\.)?bitbucket\.org\/[^/]+\/[^/]+\/pull-requests\/(\d+)(?:[/?#]|$)/i;
const CODEBERG_PR = /^https?:\/\/(?:www\.)?codeberg\.org\/[^/]+\/[^/]+\/pulls\/(\d+)(?:[/?#]|$)/i;
const CHANGE_REQUEST = /https?:\/\/(?:(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+(?::\d+)?\/[\w./-]+?\/-\/merge_requests\/\d+|(?:www\.)?bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+|(?:www\.)?codeberg\.org\/[\w.-]+\/[\w.-]+\/pulls\/\d+)(?![\w-])/gi;

export function threadLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.href.length <= MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

export function threadLinkLabel(url: string): string | null {
  const github = GITHUB.exec(url);
  if (github) return `#${github[1]}`;
  const mergeRequest = GITLAB_MR.exec(url);
  if (mergeRequest) return `!${mergeRequest[1]}`;
  const bitbucketPr = BITBUCKET_PR.exec(url);
  if (bitbucketPr) return `#${bitbucketPr[1]}`;
  const codebergPr = CODEBERG_PR.exec(url);
  return codebergPr ? `#${codebergPr[1]}` : null;
}

export function lastChangeRequestUrl(text: string): string | null {
  const match = [...text.matchAll(CHANGE_REQUEST)].at(-1)?.[0];
  return match ? threadLinkUrl(match) : null;
}

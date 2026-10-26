import { GITHUB_REPOSITORY_URL } from "./site";

export const RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

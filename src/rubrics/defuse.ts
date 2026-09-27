/** Turns any run of 3+ dashes into an em dash, so scraped text can never spell a
 * `---BEGIN/END ...---` data marker and close the block early. */
export function defuseMarkers(text: string): string {
  return text.replace(/-{3,}/g, "—");
}

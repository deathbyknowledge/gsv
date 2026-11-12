/** Line marks on the 20px grid at a 1.2 stroke, the style Help and When things happen draw their icons in. */
export const LINE_ICONS = {
  search: "M8.5 3a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm4 9.5L17 17",
  archive: "M2 3h16v4H2V3Zm1 4v10h14V7M8 10h4",
  contacts: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5M13 3a3 3 0 0 1 0 6m1 3.2c2.4.6 4 2.4 4 4.8",
  requests: "M2 5h12v10H2V5Zm0 1 6 4.5L14 6m3-2v7m0 2.5v1",
  connect: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5M16 4v6m-3-3h6",
} as const;

export function LineIcon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d={path} /></svg>;
}

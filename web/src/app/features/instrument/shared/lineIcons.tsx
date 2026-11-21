/** Line marks on the 20px grid at a 1.2 stroke, the style the header, Help and When things happen draw their icons in. */
export const LINE_ICONS = {
  chat: "M3 3h14v10H8l-5 4V3Z",
  work: "M2 6.5h16V17H2V6.5Zm5 0v-3h6v3M2 11h16",
  memory: "M3 3h6l1 2 1-2h6v14h-6l-1 1-1-1H3V3Zm7 2v13",
  settings: "M3 5h14M3 15h14M7 2v6M13 12v6",
  help: "M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM7.7 7.9a2.3 2.3 0 1 1 3.4 2c-.8.5-1.1 1-1.1 1.8v.6m0 1.9v1.3",
  phone: "M6 2h8v16H6V2Zm3 13h2",
  privacy: "M4 9h12v9H4V9Zm2 0V6a4 4 0 0 1 8 0v3",
  search: "M8.5 3a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm4 9.5L17 17",
  archive: "M2 3h16v4H2V3Zm1 4v10h14V7M8 10h4",
  contacts: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5M13 3a3 3 0 0 1 0 6m1 3.2c2.4.6 4 2.4 4 4.8",
  requests: "M2 5h12v10H2V5Zm0 1 6 4.5L14 6m3-2v7m0 2.5v1",
  connect: "M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-3 2-5 5-5s5 2 5 5M16 4v6m-3-3h6",
} as const;

export function LineIcon({ path, size = 18, class: className }: { path: string; size?: number; class?: string }) {
  return <svg class={className} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d={path} /></svg>;
}

/** Shared terminal notation for approval requests and executed commands. */
export function commandLine(who: string, target: string | null, command: string) {
  return <span class="cmd"><span class="who">{who}</span>{target ? <>@<span class="where">{target}</span></> : null} $ {command}</span>;
}

import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { ledgerFromSysLines, sysLedgerListResultSchema } from "../fleet/fleetModel";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_LEDGER_PAGE } from "./queryKeys";

const NO_CURSOR: string | null = null;
const LEDGER_QUERY_KEY = INSTRUMENT_LEDGER_KEY;
const LEDGER_PAGE = INSTRUMENT_LEDGER_PAGE;

export function useLedger(enabled: boolean) {
  const { client, connected } = useGateway();
  /* the Kernel's ledger, newest first, a page at a time; a refetch walks every loaded page again so there is never a gap */
  return useInfiniteQuery({
    queryKey: [...LEDGER_QUERY_KEY, "sys"],
    enabled: connected && enabled,
    retry: false,
    initialPageParam: NO_CURSOR,
    queryFn: async ({ pageParam }) => {
      const raw = await client.call("sys.ledger.list", pageParam ? { limit: LEDGER_PAGE, cursor: pageParam } : { limit: LEDGER_PAGE });
      const page = sysLedgerListResultSchema.parse(raw);
      return { lines: ledgerFromSysLines(page.lines), nextCursor: page.nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

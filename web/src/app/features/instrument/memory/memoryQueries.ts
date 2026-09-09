import type { QueryClient } from "@tanstack/preact-query";
import { extractLibraryTitle } from "../../gsv-console/library/libraryModel";
import type { LibrarySavePageInput } from "../../gsv-console/library/libraryTypes";
import { INSTRUMENT_MEMORY_KEY } from "../wire/queryKeys";

export async function refreshSavedMemoryPage(queryClient: QueryClient, input: LibrarySavePageInput): Promise<void> {
  const affectedKeys = [
    [...INSTRUMENT_MEMORY_KEY, "page", input.db],
    [...INSTRUMENT_MEMORY_KEY, "pages", input.db],
    [...INSTRUMENT_MEMORY_KEY, "search", input.db],
  ];
  // Inactive reads survive navigation; retire their results before publishing the save.
  await Promise.all(affectedKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  queryClient.setQueryData([...INSTRUMENT_MEMORY_KEY, "page", input.db, input.path], {
    path: input.path,
    title: extractLibraryTitle(input.markdown, input.path),
    markdown: input.markdown,
  });
  await Promise.all(affectedKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

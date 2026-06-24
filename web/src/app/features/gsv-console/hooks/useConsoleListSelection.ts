import { useEffect, useState } from "preact/hooks";
import {
  NEW_DETAIL_ID,
  type ConsoleListKind,
  type ConsoleListSelection,
  type SelectedConsoleDetail,
} from "../domain/consoleListTypes";

type UseConsoleListSelectionArgs = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  kind: ConsoleListKind;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

export function useConsoleListSelection({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  kind,
  onSelectionChange,
}: UseConsoleListSelectionArgs) {
  const [selectedDetail, setSelectedDetail] = useState<SelectedConsoleDetail | null>(null);

  useEffect(() => {
    if (initialCreate) {
      setSelectedDetail({ kind, id: NEW_DETAIL_ID, createNew: true });
      return;
    }
    setSelectedDetail(initialDetailId ? { kind, id: initialDetailId, label: initialDetailLabel ?? undefined } : null);
  }, [kind, initialCreate, initialDetailId, initialDetailLabel]);

  const selectDetail = (detail: SelectedConsoleDetail | null) => {
    setSelectedDetail(detail);
    if (!onSelectionChange) {
      return;
    }
    if (!detail) {
      onSelectionChange(null);
      return;
    }
    if (detail.createNew) {
      onSelectionChange({ createNew: true });
      return;
    }
    onSelectionChange({ detailId: detail.id, detailLabel: detail.label });
  };

  return { selectedDetail, selectDetail };
}

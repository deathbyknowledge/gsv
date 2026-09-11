import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import type { ProcSpawnArgs } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { reasoningOptions } from "../../../domain/reasoning";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { requestFsRead } from "../../../services/gateway/fsRead";
import { getChatProcessAiConfig, setChatProcessAiConfig, spawnChatProcess } from "../../../services/chat/backend/chatService";
import { loadConsoleModels } from "../../../services/system/consoleService";
import { instrumentProcessAiKey, INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";

const modelChoicesSchema = z.array(z.object({ id: z.string(), name: z.string() }));
type ModelChoice = z.infer<typeof modelChoicesSchema>[number];
type AiSelection = { modelId: string; reasoning: string };
const INHERIT: AiSelection = { modelId: "", reasoning: "" };

function AiFields({ value, models, onChange }: {
  value: AiSelection;
  models: readonly ModelChoice[];
  onChange: (value: AiSelection) => void;
}) {
  return (
    <>
      <label>
        First-choice model
        <select class="fleet-select" value={value.modelId} onChange={(event) => onChange({ ...value, modelId: event.currentTarget.value })}>
          <option value="">Use defaults</option>
          {value.modelId && !models.some((model) => model.id === value.modelId)
            ? <option value={value.modelId}>{value.modelId} (unavailable)</option> : null}
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      <label>
        Reasoning effort
        <select class="fleet-select" value={value.reasoning} onChange={(event) => onChange({ ...value, reasoning: event.currentTarget.value })}>
          {reasoningOptions(undefined).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </>
  );
}

export function NewProcess({ onCreated, onCancel }: { onCreated: (pid: string) => void; onCancel: () => void }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [ai, setAi] = useState<AiSelection>(INHERIT);
  const models = useQuery({
    queryKey: ["fleet", "models"],
    queryFn: () => loadConsoleModels(client),
    enabled: connected,
  });
  const create = useMutation({
    mutationFn: () => {
      const args: ProcSpawnArgs = { interactive: true };
      if (label.trim()) args.label = label.trim();
      if (ai.modelId || ai.reasoning) {
        args.ai = {};
        if (ai.modelId) args.ai.modelId = ai.modelId;
        if (ai.reasoning) args.ai.reasoning = ai.reasoning;
      }
      return spawnChatProcess(client, args);
    },
    onSuccess: ({ pid }) => {
      void queryClient.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY });
      onCreated(pid);
    },
  });

  return (
    <div>
      <h3>New process</h3>
      <p class="note">Start a separate conversation with your agent. Choose its settings before the first message.</p>
      <form class="fleet-process-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <fieldset disabled={!connected || create.isPending}>
          <label>Name (optional)<input autoFocus value={label} onInput={(event) => setLabel(event.currentTarget.value)} /></label>
          <AiFields value={ai} models={models.data?.models ?? []} onChange={setAi} />
          <p class="note">Defaults inherit your account settings. Choosing a model puts it first; the rest of your fallback stack still applies.</p>
          <div class="fleet-actions">
            <button class="ibtn is-primary" type="submit">{create.isPending ? <LoadingState>creating…</LoadingState> : "open conversation"}</button>
            <button class="fleet-text-action" type="button" onClick={onCancel}>cancel</button>
          </div>
        </fieldset>
        {models.isPending ? <p class="note"><LoadingState>loading models…</LoadingState></p> : null}
        {models.error ? <p class="error" role="alert">Could not load models: {models.error.message}</p> : null}
        {create.error ? <p class="error" role="alert">{create.error.message}</p> : null}
      </form>
    </div>
  );
}

export function ProcessAiControls({ pid, canEdit }: { pid: string; canEdit: boolean }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AiSelection | null>(null);
  const config = useQuery({
    queryKey: instrumentProcessAiKey(pid),
    queryFn: () => getChatProcessAiConfig(client, { pid }),
    enabled: connected,
  });
  const models = useQuery({
    queryKey: ["fleet", "process-models", pid],
    queryFn: async () => {
      const result = await requestFsRead(client, { path: `/proc/${pid}/ai/models` });
      if (!result.ok) throw new Error(result.error);
      if (!("kind" in result) || result.kind !== "text") throw new Error("Could not read this process's models");
      return modelChoicesSchema.parse(JSON.parse(result.content));
    },
    enabled: connected && canEdit,
  });
  const saved = { modelId: config.data?.modelId ?? "", reasoning: config.data?.reasoning ?? "" };
  const value = draft ?? saved;
  const dirty = value.modelId !== saved.modelId || value.reasoning !== saved.reasoning;
  const apply = useMutation({
    mutationFn: () => setChatProcessAiConfig(client, { pid, modelId: value.modelId || null, reasoning: value.reasoning || null }),
    onSuccess: (result) => {
      queryClient.setQueryData(instrumentProcessAiKey(pid), result.config);
      setDraft(null);
    },
  });

  return (
    <form class="fleet-process-form" onSubmit={(event) => { event.preventDefault(); apply.mutate(); }}>
      <h4>Next run</h4>
      {config.isPending ? <p class="note"><LoadingState>loading settings…</LoadingState></p> : config.error ? (
        <p class="error" role="alert">Could not read settings: {config.error.message}</p>
      ) : (
        <>
          <fieldset disabled={!connected || !canEdit || apply.isPending}>
            <AiFields value={value} models={models.data ?? []} onChange={setDraft} />
            <p class="note">Applies to this process from its next run. Your normal model fallbacks still apply.</p>
            {canEdit ? <div class="fleet-actions">
              <button class="ibtn is-primary" type="submit" disabled={!dirty}>{apply.isPending ? <LoadingState>saving…</LoadingState> : "apply settings"}</button>
              <button class="fleet-text-action" type="button" onClick={() => setDraft(INHERIT)} disabled={!value.modelId && !value.reasoning}>use defaults</button>
            </div> : null}
          </fieldset>
          {apply.isSuccess && !dirty ? <p class="note" role="status">Settings saved.</p> : null}
          {models.error ? <p class="error" role="alert">Could not load models: {models.error.message}</p> : null}
          {apply.error ? <p class="error" role="alert">{apply.error.message}</p> : null}
        </>
      )}
    </form>
  );
}

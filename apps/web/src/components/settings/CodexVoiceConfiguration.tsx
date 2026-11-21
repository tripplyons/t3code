import { cloudSpeechDisclosure } from "@t3tools/shared/speechCopy";
import { getCloudSpeechKeys } from "@t3tools/client-runtime/voice-input";
import { AuthOrchestrationOperateScope, type ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { useId, useState } from "react";
import { chooseAudioDestination, useAudioChoice } from "../../speech/voiceConsent";
import { useEnvironmentProviders, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { useCloudRead } from "./CloudVoiceConfiguration";

/** Codex dictation needs no key: the device picks which Codex sign-in on the environment pays. */
export function CodexVoiceConfiguration({
  environment,
  active,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;
  active: boolean;
  close: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const id = environment.environmentId;
  const labelId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const current =
    active && grant?.destination.kind === "cloud" && grant.destination.provider === "codex"
      ? grant.destination.instanceId
      : undefined;
  const signedIn = AsyncResult.isSuccess(presence) ? presence.value?.codex : undefined;
  const [instanceId, setInstanceId] = useState(current);
  // A single sign-in needs no choice; the list loads after the dialog opens.
  const chosen = instanceId ?? (signedIn?.length === 1 ? signedIn[0] : undefined);
  const providers = useEnvironmentProviders().get(id);
  const describe = (instance: ProviderInstanceId) => {
    const provider = providers?.find((entry) => entry.instanceId === instance);
    return {
      name: provider?.displayName ?? (instance === "codex" ? "Codex" : instance),
      email: provider?.auth.email,
    };
  };
  const connected = canUse && prepared !== null;
  const canSubmit =
    chosen !== undefined && signedIn?.includes(chosen) === true && chosen !== current;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {active ? gt("Manage Codex dictation") : gt("Use Codex for dictation?")}
          </DialogTitle>
          <DialogDescription>
            {cloudSpeechDisclosure("codex", environment.label, messages)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!connected ? (
            <p>
              {gt("Connect to {environment} with dictation access to continue.", {
                environment: environment.label,
              })}
            </p>
          ) : AsyncResult.isFailure(presence) ? (
            <Button size="sm" variant="outline" onClick={refresh}>
              {gt("Retry loading Codex sign-ins")}
            </Button>
          ) : !AsyncResult.isSuccess(presence) || !presence.value ? (
            <p role="status">{gt("Checking Codex sign-ins…")}</p>
          ) : signedIn === undefined ? (
            <p>
              {gt("Update {environment} to use Codex dictation.", {
                environment: environment.label,
              })}
            </p>
          ) : signedIn.length === 0 ? (
            <p>
              {gt("Sign in to Codex with ChatGPT on {environment} to use Codex dictation.", {
                environment: environment.label,
              })}
            </p>
          ) : (
            <div className="grid gap-2">
              <span id={labelId} className="font-medium text-sm">
                {gt("Codex sign-in")}
              </span>
              <RadioGroup
                aria-labelledby={labelId}
                value={chosen ?? null}
                onValueChange={(next) => setInstanceId(next as ProviderInstanceId)}
              >
                {signedIn.map((instance) => {
                  const { name, email } = describe(instance);
                  return (
                    <label
                      key={instance}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm"
                    >
                      <Radio value={instance} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{name}</span>
                        {email && (
                          <span className="truncate text-xs text-muted-foreground">{email}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
              <p className="text-sm text-muted-foreground">
                {gt("This choice applies only to this device.")}
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" size="sm" variant="outline" onClick={close}>
            {gt("Cancel")}
          </Button>
          {connected && signedIn && signedIn.length > 0 && (
            <Button
              type="button"
              size="sm"
              disabled={!canSubmit}
              onClick={() => {
                if (!chosen) return;
                chooseAudioDestination({
                  kind: "cloud",
                  environmentId: id,
                  provider: "codex",
                  instanceId: chosen,
                });
                close();
              }}
            >
              {active ? gt("Save") : gt("Use Codex")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { DEFAULT_VOICE, isBuiltInVoice, LocalVoiceEngine } from "./engine.ts";
import { ModelStore } from "./models.ts";
import type { VoiceRequest } from "./voice-process.ts";

const engine = new LocalVoiceEngine(new ModelStore());

function run(request: VoiceRequest): Promise<unknown> {
  switch (request.op) {
    case "warm": return engine.warm(request.halves);
    case "speak": return engine.speak(request.text, isBuiltInVoice(request.voice) ? request.voice : DEFAULT_VOICE, request.speed);
    case "transcribe": return engine.transcribe(request.samples);
  }
}

process.on("message", (request: VoiceRequest & { id: number }) => {
  run(request).then(
    (value) => process.send?.({ id: request.id, ok: true, value }),
    (error: unknown) => process.send?.({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
});
process.on("disconnect", () => process.exit(0));

// The custom provider driver loads pi-ai's chat-completions module on first
// use. In a full parallel run that first import can wait several seconds on
// the Vite server, longer than a test's budget, so each test file loads it
// before its tests start.
import "@earendil-works/pi-ai/api/openai-completions";

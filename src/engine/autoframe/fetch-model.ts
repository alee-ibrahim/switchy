/** `npm run models` / Docker build: download and verify the face model and the head/upper-body fallback models. */
import { ensureModel, modelsDir, RTMDET_PERSON, RTMPOSE_T, YUNET } from './model.js';

(async () => {
  for (const spec of [YUNET, RTMDET_PERSON, RTMPOSE_T]) {
    const f = await ensureModel(spec, modelsDir());
    console.log(`model ok: ${f} (${spec.licence.split(' ')[0]})`);
  }
})().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

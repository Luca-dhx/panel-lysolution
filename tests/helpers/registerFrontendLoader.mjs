// Branche la résolution des modules frontend pour un runner node.
import { register } from 'node:module';
register('./frontendLoader.mjs', import.meta.url);

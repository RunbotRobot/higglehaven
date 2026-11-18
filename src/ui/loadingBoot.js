// #3738: the first script the page asks for. It is tiny on purpose: it starts the
// tips and wires Try again so the opening screen is alive long before the main
// bundle (src/main.js) has downloaded. The stages themselves are reported from
// src/main.js and src/shop/mode.js through ./loadingStages.js.
import { startLoadingTips } from './loadingStages.js';

startLoadingTips();
const retry = document.getElementById('loading-retry');
if (retry) retry.addEventListener('click', () => location.reload());

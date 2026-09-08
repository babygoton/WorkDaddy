// Use goober's documented target binding so upstream Toaster animations and
// icons stay inside our shadow root, without touching WorkBuddy's stylesheet.
import { css as baseCss, styled as baseStyled, setup } from './node_modules/goober/dist/goober.modern.js';
export const styleTarget = document.createElement('div');
styleTarget.hidden = true;
styleTarget.id = 'wbs-toast-library-styles';
export const css = baseCss.bind({ target: styleTarget });
export const keyframes = baseCss.bind({ target: styleTarget, k: 1 });
export const styled = baseStyled.bind({ target: styleTarget });
export { setup };

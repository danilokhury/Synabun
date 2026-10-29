// Deprecated 2D page: static hosts also resolve old bookmarks to the supported 3D page.
import { normalizeViewUrl } from './view-variant.js';
window.location.replace(normalizeViewUrl(window.location.href));

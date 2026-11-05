import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The MARS logo: 4 cells wide and 2 lines tall. Each cell shows two square pixels with
 * half blocks, drawing an "M":
 *
 *   coral . blue  coral
 *   coral . blue  coral
 *   coral coral . coral
 *   coral .     . coral
 *
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// Top: coral full, blue upper-half over coral lower (blue/coral peak), coral full.
	const top = `${fg(CORAL)}█${RESET}${fg(BLUE)}${backgroundAnsi(CORAL, mode)}▀${RESET}${fg(CORAL)}█${RESET} `;
	// Bottom: coral full, coral lower-half (valley), coral full.
	const bottom = `${fg(CORAL)}█▄█${RESET} `;
	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: the app name with the logo's coral and yellow. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	const name = APP_NAME;
	return `${foregroundAnsi(CORAL, mode)}${name.slice(0, -1)}${RESET}${foregroundAnsi(YELLOW, mode)}${name.slice(-1)}${RESET}`;
}

export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.MARS_EXPERIMENTAL === "1";
}

export const MAX_SNAPSHOT_PREDICTION_SECONDS = 0.5;

/**
 * Return how far an authoritative snapshot should be projected to represent
 * the estimated server state at the moment it reaches this client.
 */
export function getSnapshotPredictionSeconds(
	serverTimestamp,
	estimatedServerNow,
	maxPrediction = MAX_SNAPSHOT_PREDICTION_SECONDS
) {
	if (
		!Number.isFinite(serverTimestamp) ||
		!Number.isFinite(estimatedServerNow) ||
		!Number.isFinite(maxPrediction) ||
		maxPrediction <= 0
	) {
		return 0;
	}

	return Math.min(
		Math.max((estimatedServerNow - serverTimestamp) / 1000, 0),
		maxPrediction
	);
}

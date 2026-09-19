import {
	MAX_SNAPSHOT_PREDICTION_SECONDS,
	getSnapshotPredictionSeconds
} from './prediction.js';

describe('snapshot prediction', () => {
	test('projects a snapshot by its estimated one-way age', () => {
		expect(getSnapshotPredictionSeconds(1000, 1125)).toBeCloseTo(0.125);
	});

	test('clamps stale or invalid snapshots', () => {
		expect(getSnapshotPredictionSeconds(1000, 3000)).toBe(
			MAX_SNAPSHOT_PREDICTION_SECONDS
		);
		expect(getSnapshotPredictionSeconds(2000, 1000)).toBe(0);
		expect(getSnapshotPredictionSeconds(undefined, 1000)).toBe(0);
	});
});

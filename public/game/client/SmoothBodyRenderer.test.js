import * as THREE from 'three';
import { SmoothBodyRenderer } from './SmoothBodyRenderer.js';

function makeBody(x = 0, velocity = 0) {
	return {
		x: new THREE.Vector3(x, 0, 0),
		v: new THREE.Vector3(velocity, 0, 0)
	};
}

describe('SmoothBodyRenderer', () => {
	test('extrapolates between fixed physics ticks', () => {
		const visual = new THREE.Object3D();
		const renderer = new SmoothBodyRenderer(visual, makeBody(1, 2));

		renderer.render(0, 0.25);

		expect(visual.position.x).toBeCloseTo(1.5);
	});

	test('keeps a snapshot correction visually continuous', () => {
		const visual = new THREE.Object3D();
		const body = makeBody(0, 0);
		const renderer = new SmoothBodyRenderer(visual, body, {
			correctionRate: Math.log(2)
		});

		renderer.preserveRenderedPosition(new THREE.Vector3(1, 0, 0));
		expect(visual.position.x).toBeCloseTo(1);

		renderer.render(1, 0);
		expect(visual.position.x).toBeCloseTo(0.5);
	});
});

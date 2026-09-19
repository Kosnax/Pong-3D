export class GameAudio {
	constructor({ muted = false, volume = 0.18 } = {}) {
		this.context = null;
		this.master = null;
		this.muted = muted;
		this.volume = volume;
		this.lastPlayedAt = new Map();
	}

	unlock() {
		const AudioContext = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContext) return false;

		if (!this.context) {
			this.context = new AudioContext();
			this.master = this.context.createGain();
			this.master.gain.value = this.muted ? 0 : this.volume;
			this.master.connect(this.context.destination);
		}

		if (this.context.state === 'suspended') this.context.resume();
		return true;
	}

	setMuted(muted) {
		this.muted = Boolean(muted);
		if (this.master && this.context) {
			this.master.gain.setTargetAtTime(
				this.muted ? 0 : this.volume,
				this.context.currentTime,
				0.01
			);
		}
	}

	playHit(speed = 5) {
		if (!this.#canPlay('hit', 45)) return;
		this.#tone(230 + Math.min(speed, 18) * 24, 0.055, 0.12, 'square', 1.35);
	}

	playWall(speed = 5) {
		if (!this.#canPlay('wall', 55)) return;
		this.#tone(120 + Math.min(speed, 18) * 8, 0.04, 0.075, 'triangle', 0.72);
	}

	playCountdown(value) {
		if (!this.#canPlay(`countdown-${value}`, 400)) return;
		this.#tone(value === 1 ? 620 : 440, 0.09, 0.1, 'sine', 1.05);
	}

	playGoal() {
		if (!this.#canPlay('goal', 500)) return;
		this.#sequence([260, 390, 520], 0.085, 0.12, 'sawtooth');
	}

	playGameOver(won) {
		if (!this.#canPlay('game-over', 1000)) return;
		const notes =
			won === null ? [330, 440, 550] : won ? [330, 440, 660] : [360, 300, 220];
		this.#sequence(notes, 0.14, 0.12, 'triangle');
	}

	#canPlay(key, minimumGapMs) {
		if (this.muted || !this.unlock()) return false;
		const now = performance.now();
		const previous = this.lastPlayedAt.get(key) ?? -Infinity;
		if (now - previous < minimumGapMs) return false;
		this.lastPlayedAt.set(key, now);
		return true;
	}

	#sequence(notes, spacing, gain, type) {
		notes.forEach((frequency, index) => {
			this.#tone(frequency, 0.12, gain, type, 1, index * spacing);
		});
	}

	#tone(frequency, duration, gain, type = 'sine', endRatio = 1, delay = 0) {
		if (!this.context || !this.master) return;
		const start = this.context.currentTime + delay;
		const oscillator = this.context.createOscillator();
		const envelope = this.context.createGain();

		oscillator.type = type;
		oscillator.frequency.setValueAtTime(frequency, start);
		oscillator.frequency.exponentialRampToValueAtTime(
			Math.max(20, frequency * endRatio),
			start + duration
		);
		envelope.gain.setValueAtTime(0.0001, start);
		envelope.gain.exponentialRampToValueAtTime(gain, start + 0.008);
		envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

		oscillator.connect(envelope);
		envelope.connect(this.master);
		oscillator.start(start);
		oscillator.stop(start + duration + 0.02);
	}
}

/**
 * Asteroids Webpage Destroyer Easter Egg
 * Fully self-contained. Trigger by typing "kickass" anywhere.
 *
 * Teardown: exposes window.__easterEggTeardown() which removes the trigger
 * listener and stops/cleans up any running game. Safe to call multiple times.
 * Re-injecting this script is a no-op while an install is already active.
 */
(function () {
	// Idempotent install guard: if already installed, do nothing.
	if (window.__easterEggTeardown) return;

	// 1. Secret Keyword Trigger Setup
	const secretCode = 'kickass';
	let inputSequence = '';
	let teardownGame = null; // set while a game is running

	function onTriggerKeydown(e) {
		if (e.key.length === 1) {
			inputSequence += e.key.toLowerCase();
			if (inputSequence.length > secretCode.length) {
				inputSequence = inputSequence.slice(-secretCode.length);
			}
			if (inputSequence === secretCode) {
				startGame();
				inputSequence = '';
			}
		}
	}

	document.addEventListener('keydown', onTriggerKeydown);

	// Global teardown hook: uninstall trigger + stop any active game.
	window.__easterEggTeardown = function () {
		document.removeEventListener('keydown', onTriggerKeydown);
		if (teardownGame) teardownGame();
		delete window.__easterEggTeardown;
	};

	// 2. Core Game Loop Engine
	function startGame() {
		if (window.WebAsteroidsActive) return;
		window.WebAsteroidsActive = true;

		console.log('Code accepted. Hitting target website...');

		let rafId = 0;

		// Setup fullscreen canvas overlay
		const canvas = document.createElement('canvas');
		canvas.id = 'asteroids-game-canvas';
		canvas.style.position = 'fixed';
		canvas.style.top = '0';
		canvas.style.left = '0';
		canvas.style.width = '100vw';
		canvas.style.height = '100vh';
		canvas.style.zIndex = '999999';
		canvas.style.pointerEvents = 'none'; // Keeps regular page clickable until game initializes
		document.body.appendChild(canvas);

		const ctx = canvas.getContext('2d');
		let width = (canvas.width = window.innerWidth);
		let height = (canvas.height = window.innerHeight);

		// Automatically handle browser window resizing
		function onResize() {
			width = canvas.width = window.innerWidth;
			height = canvas.height = window.innerHeight;
		}
		window.addEventListener('resize', onResize);

		// Ship settings and state
		const ship = {
			x: width / 2,
			y: height / 2,
			r: 10, // radius
			a: -Math.PI / 2, // angle facing up
			rot: 0,
			thrusting: false,
			thrust: { x: 0, y: 0 }
		};

		const bullets = [];
		const FRICTION = 0.98;
		const SHIP_SPEED = 0.15;
		const ROT_SPEED = 0.08;
		const BULLET_SPEED = 7;

		// Track active movement keys
		const keys = {};
		function onKeyDownMove(e) {
			console.log(e.code);
			keys[e.code] = true;
		}
		function onKeyUpMove(e) {
			console.log(e.code);
			keys[e.code] = false;
		}
		window.addEventListener('keydown', onKeyDownMove);
		window.addEventListener('keyup', onKeyUpMove);

		// Fire single bullets on tap; Escape quits.
		function onKeyDownAction(e) {
			if (e.code === 'Space' && window.WebAsteroidsActive) {
				e.preventDefault();
				bullets.push({
					x: ship.x + (4 / 3) * ship.r * Math.cos(ship.a),
					y: ship.y + (4 / 3) * ship.r * Math.sin(ship.a),
					xv: BULLET_SPEED * Math.cos(ship.a),
					yv: BULLET_SPEED * Math.sin(ship.a),
					life: 60 // frames to live
				});
			}
			if (e.code === 'Escape') {
				cleanUpGame();
			}
		}
		window.addEventListener('keydown', onKeyDownAction);

		// 3. Main Game Rendering Loop
		function update() {
			if (!window.WebAsteroidsActive) return;

			// Clear frame canvas transparently
			ctx.clearRect(0, 0, width, height);

			// Handle rotations
			if (keys['ArrowLeft'] || keys['KeyA'] || keys['KeyM'])
				ship.a -= ROT_SPEED;
			if (keys['ArrowRight'] || keys['KeyD'] || keys['Period'])
				ship.a += ROT_SPEED;

			// Handle forward rocket thrust mechanics
			if (keys['ArrowUp'] || keys['KeyW'] || keys['Comma']) {
				ship.thrust.x += SHIP_SPEED * Math.cos(ship.a);
				ship.thrust.y += SHIP_SPEED * Math.sin(ship.a);
				ship.thrusting = true;
			} else {
				ship.thrust.x *= FRICTION;
				ship.thrust.y *= FRICTION;
				ship.thrusting = false;
			}

			// Move the ship
			ship.x += ship.thrust.x;
			ship.y += ship.thrust.y;

			// Screen edge wrapping for the spaceship
			if (ship.x < -ship.r) ship.x = width + ship.r;
			if (ship.x > width + ship.r) ship.x = -ship.r;
			if (ship.y < -ship.r) ship.y = height + ship.r;
			if (ship.y > height + ship.r) ship.y = -ship.r;

			// Draw the retro triangleship
			ctx.strokeStyle = '#cccccc';
			ctx.fillStyle = '#111';
			ctx.lineWidth = 2;
			ctx.shadowBlur = 3;
			ctx.shadowColor = '#007969'; // Cyberpunk neon glow effect
			ctx.beginPath();
			ctx.moveTo(
				ship.x + (4 / 3) * ship.r * Math.cos(ship.a),
				ship.y + (4 / 3) * ship.r * Math.sin(ship.a)
			);
			ctx.lineTo(
				ship.x - ship.r * ((2 / 3) * Math.cos(ship.a) + Math.sin(ship.a)),
				ship.y - ship.r * ((2 / 3) * Math.sin(ship.a) - Math.cos(ship.a))
			);
			ctx.lineTo(
				ship.x - ship.r * ((2 / 3) * Math.cos(ship.a) - Math.sin(ship.a)),
				ship.y - ship.r * ((2 / 3) * Math.sin(ship.a) + Math.cos(ship.a))
			);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();

			// Draw engine thrust flame animation
			if (ship.thrusting) {
				ctx.strokeStyle = 'orange';
				ctx.beginPath();
				ctx.moveTo(
					ship.x - ((ship.r * 2) / 3) * Math.cos(ship.a),
					ship.y - ((ship.r * 2) / 3) * Math.sin(ship.a)
				);
				ctx.lineTo(
					ship.x -
						ship.r * ((5 / 4) * Math.cos(ship.a) + 0.25 * Math.sin(ship.a)),
					ship.y -
						ship.r * ((5 / 4) * Math.sin(ship.a) - 0.25 * Math.cos(ship.a))
				);
				ctx.lineTo(
					ship.x -
						ship.r * ((5 / 4) * Math.cos(ship.a) - 0.25 * Math.sin(ship.a)),
					ship.y -
						ship.r * ((5 / 4) * Math.sin(ship.a) + 0.25 * Math.cos(ship.a))
				);
				ctx.closePath();
				ctx.stroke();
			}

			// Move and render fire bullets
			ctx.shadowColor = '#ff0055';
			for (let i = bullets.length - 1; i >= 0; i--) {
				const b = bullets[i];
				b.x += b.xv;
				b.y += b.yv;
				b.life--;

				// Destroy HTML nodes when a laser bullet passes through them
				destroyDOMElementAt(b.x, b.y);

				// Draw bullet
				ctx.fillStyle = '#ff0055';
				ctx.beginPath();
				ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
				ctx.fill();

				if (b.life <= 0 || b.x < 0 || b.x > width || b.y < 0 || b.y > height) {
					bullets.splice(i, 1);
				}
			}

			rafId = requestAnimationFrame(update);
		}

		// 4. Element Obliteration Logic (The Magic Component)
		//
		// Selective destruction: only leaf elements (those with no element
		// children) can be shot, and larger leaves are progressively harder to
		// destroy. This chips away small / deeply-nested things first; a
		// container only becomes destroyable once its children are gone.
		const MAX_DESTROY_AREA = 40000; // px^2 (~200x200) hard cap; bigger leaves survive

		function destroyDOMElementAt(x, y) {
			// Find what specific HTML element lives at the bullet coordinates
			const element = document.elementFromPoint(x, y);

			if (
				!element ||
				element === document.body ||
				element === document.documentElement ||
				element === canvas ||
				element.tagName === 'HTML'
			) {
				return;
			}

			// Only destroy true leaf elements (no child elements). This protects
			// containers until their small inner nodes have been cleared out.
			if (element.children.length > 0) return;

			const rect = element.getBoundingClientRect();
			const area = rect.width * rect.height;

			// Skip oversized leaves outright...
			if (area > MAX_DESTROY_AREA) return;

			// ...and make bigger leaves probabilistic: small things pop instantly,
			// larger ones need several hits before a bullet lands the kill.
			const destroyChance = 1 - area / MAX_DESTROY_AREA;
			if (Math.random() > destroyChance) return;

			// Add a structural impact animation before deleting
			element.style.transition = 'transform 0.1s ease, opacity 0.15s ease';
			element.style.transform = 'scale(0.3)';
			element.style.opacity = '0';

			// Safely remove the element from the live DOM structure
			setTimeout(() => {
				if (element && element.parentNode) {
					element.parentNode.removeChild(element);
				}
			}, 100);
		}

		// 5. Exit Routine: stop loop, remove listeners + canvas.
		function cleanUpGame() {
			if (!window.WebAsteroidsActive) return;
			window.WebAsteroidsActive = false;
			if (rafId) cancelAnimationFrame(rafId);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('keydown', onKeyDownMove);
			window.removeEventListener('keyup', onKeyUpMove);
			window.removeEventListener('keydown', onKeyDownAction);
			const liveCanvas = document.getElementById('asteroids-game-canvas');
			if (liveCanvas) liveCanvas.remove();
			teardownGame = null;
			console.log('Game Session Ended.');
		}

		// Expose this game's teardown so the global hook can stop it.
		teardownGame = cleanUpGame;

		// Start the animation engine loop
		rafId = requestAnimationFrame(update);
	}
})();

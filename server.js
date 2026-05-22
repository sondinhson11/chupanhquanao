/// <reference types="@citizenfx/server" />
/// <reference types="image-js" />

const imagejs = require('image-js');
const https = require('https');

const resName = GetCurrentResourceName();
const config = JSON.parse(LoadResourceFile(GetCurrentResourceName(), "config.json"));

/**
 * Push a PNG buffer to GitHub via the Contents API.
 * If the file already exists, it will be overwritten (requires the blob SHA).
 * @param {string} filePath  - path inside the repo, e.g. "clothing/male_1_0.png"
 * @param {Buffer} pngBuffer - raw PNG bytes
 * @returns {Promise<string>} - public URL of the uploaded file
 */
async function pushToGitHub(filePath, pngBuffer) {
	const { token, repo, branch } = config.github;

	// Ensure clean base64 — no line breaks or whitespace
	const base64Content = pngBuffer.toString('base64').replace(/[\r\n\s]/g, '');

	// 1. Check if file already exists to get its SHA (needed for update)
	const existingSha = await getFileSha(token, repo, branch, filePath);

	const body = JSON.stringify({
		message: `upload ${filePath}`,
		content: base64Content,
		branch: branch,
		...(existingSha ? { sha: existingSha } : {}),
	});

	return new Promise((resolve, reject) => {
		const options = {
			hostname: 'api.github.com',
			path: `/repos/${repo}/contents/${filePath}`,
			method: 'PUT',
			headers: {
				'Authorization': `token ${token}`,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				'User-Agent': 'fivem-greenscreener',
				'Accept': 'application/vnd.github.v3+json',
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				try {
					const json = JSON.parse(data);
					if (res.statusCode === 200 || res.statusCode === 201) {
						resolve(json.content.html_url);
					} else {
						reject(new Error(`GitHub API error ${res.statusCode}: ${data}`));
					}
				} catch (e) {
					reject(new Error(`Failed to parse GitHub response: ${data}`));
				}
			});
		});

		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

/**
 * Get the SHA of an existing file in the repo (returns null if not found).
 */
function getFileSha(token, repo, branch, filePath) {
	return new Promise((resolve) => {
		const options = {
			hostname: 'api.github.com',
			path: `/repos/${repo}/contents/${filePath}?ref=${branch}`,
			method: 'GET',
			headers: {
				'Authorization': `token ${token}`,
				'User-Agent': 'fivem-greenscreener',
				'Accept': 'application/vnd.github.v3+json',
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				if (res.statusCode === 200) {
					try {
						const json = JSON.parse(data);
						resolve(json.sha || null);
					} catch {
						resolve(null);
					}
				} else {
					resolve(null); // file doesn't exist yet
				}
			});
		});

		req.on('error', () => resolve(null));
		req.end();
	});
}

try {
	onNet('takeScreenshot', async (filename, type) => {
		// Check if file exists and overwrite is disabled
		// For GitHub mode we skip the local existence check — GitHub API handles it via SHA
		if (config.debug) {
			console.log(`DEBUG: Processing screenshot: ${filename}.png (type: ${type})`);
		}

		// Use base64 encoding so screenshot-basic doesn't need filesystem write access
		exports['screenshot-basic'].requestClientScreenshot(
			source,
			{
				encoding: 'base64',
				quality: 1.0,
			},
			async (err, data) => {
				if (err || !data) {
					console.error(`[greenscreener] Screenshot error: ${err}`);
					return;
				}

				try {
					// Strip data URI prefix if present (data:image/png;base64,...)
					const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
					const buffer = Buffer.from(base64Data, 'base64');

					let image = await imagejs.Image.load(buffer);

					// Apply greenscreen removal
					for (let x = 0; x < image.width; x++) {
						for (let y = 0; y < image.height; y++) {
							const pixelArr = image.getPixelXY(x, y);
							const r = pixelArr[0];
							const g = pixelArr[1];
							const b = pixelArr[2];

							if (g > r + b) {
								image.setPixelXY(x, y, [255, 255, 255, 0]);
							}
						}
					}

					// Crop image to content bounds
					let minX = image.width;
					let maxX = -1;
					let minY = image.height;
					let maxY = -1;

					for (let x = 0; x < image.width; x++) {
						for (let y = 0; y < image.height; y++) {
							const pixelArr = image.getPixelXY(x, y);
							const alpha = pixelArr[3];

							if (alpha > 0) {
								minX = Math.min(minX, x);
								maxX = Math.max(maxX, x);
								minY = Math.min(minY, y);
								maxY = Math.max(maxY, y);
							}
						}
					}

					if (maxX >= minX && maxY >= minY) {
						const croppedImage = image.crop({
							x: minX,
							y: minY,
							width: maxX - minX + 1,
							height: maxY - minY + 1,
						});
						image.data = croppedImage.data;
						image.width = croppedImage.width;
						image.height = croppedImage.height;
					}

					// Convert to PNG buffer — ensure it's a proper Node.js Buffer
					const rawBuffer = await image.toBuffer({ format: 'png' });
					const pngBuffer = Buffer.isBuffer(rawBuffer)
						? rawBuffer
						: Buffer.from(rawBuffer);

					if (config.debug) {
						console.log(`DEBUG: pngBuffer type=${typeof rawBuffer}, isBuffer=${Buffer.isBuffer(rawBuffer)}, constructor=${rawBuffer?.constructor?.name}, length=${rawBuffer?.length}`);
						console.log(`DEBUG: base64 sample=${pngBuffer.toString('base64').slice(0, 50)}`);
					}

					// Push to GitHub
					const filePath = `${type}/${filename}.png`;
					const url = await pushToGitHub(filePath, pngBuffer);

					console.log(`[greenscreener] Uploaded: ${url}`);

				} catch (processErr) {
					console.error(`[greenscreener] Error processing image: ${processErr.message}`);
				}
			}
		);
	});
} catch (error) {
	console.error(error.message);
}

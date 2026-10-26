const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, "temp");
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(__dirname));

const jobs = new Map();

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", data => stdout += data.toString());
    child.stderr.on("data", data => stderr += data.toString());

    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
  });
}

// Search and return selectable results.
app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query || query.length > 200) {
    return res.status(400).json({ error: "Enter a search (up to 200 characters)." });
  }

  try {
    const output = await runYtDlp([
      "--dump-json",
      "--flat-playlist",
      "--no-warnings",
      `ytsearch8:${query}`
    ]);

    const results = output.trim().split("\n").filter(Boolean).map(line => {
      const item = JSON.parse(line);
      const id = item.id;
      return {
        id,
        title: item.title || "Untitled",
        duration: item.duration || null,
        url: item.url || (id ? `https://www.youtube.com/watch?v=${id}` : null)
      };
    }).filter(item => item.url);

    res.json({ results });
  } catch (error) {
    console.error("Search failed:", error.message);
    res.status(500).json({ error: "Search failed. Check that yt-dlp is installed and available." });
  }
});

// Download/extract the selected result as an MP3.
app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "");

  // Only accept ordinary YouTube video URLs, not arbitrary URLs.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid selection." });
  }

  const allowedHosts = ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"];
  if (!allowedHosts.includes(parsed.hostname)) {
    return res.status(400).json({ error: "Only YouTube video links are accepted." });
  }

  const id = crypto.randomUUID();
  const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

  try {
    await runYtDlp([
      "--no-playlist",
      "--no-warnings",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "192K",
      "-o", outputTemplate,
      url
    ]);

    const filePath = path.join(TEMP_DIR, `${id}.mp3`);
    if (!fs.existsSync(filePath)) throw new Error("MP3 output was not created.");

    jobs.set(id, { filePath, createdAt: Date.now(), downloading: false });
    res.json({ id });
  } catch (error) {
    console.error("Conversion failed:", error.message);
    res.status(500).json({ error: "Could not create the MP3. The source may be unavailable." });
  }
});

// Send the MP3, then remove it.
app.get("/api/file/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found or already removed.");
  }

  job.downloading = true;
  res.download(job.filePath, "audio.mp3", error => {
    removeJob(req.params.id);
    if (error) console.error("File transfer ended:", error.message);
  });
});

// Best-effort cleanup when the page is closed.
app.delete("/api/file/:id", (req, res) => {
  removeJob(req.params.id);
  res.sendStatus(204);
});

function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  fs.rm(job.filePath, { force: true }, () => {});
}

// Clean up abandoned files periodically.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > MAX_AGE_MS) removeJob(id);
  }
}, 60_000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

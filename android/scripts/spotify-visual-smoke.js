export default async () => {
  const phone = args.target;
  const song = args.song;
  const artist = args.artist;
  const query = args.query || `${song} ${artist}`;

  if (!phone || !song || !artist) {
    throw new Error("Pass target, song, and artist through --args-json");
  }

  const phoneOptions = { target: phone, cwd: "/home/android" };
  const frames = [];

  function completed(result, label) {
    if (
      !result ||
      result.status !== "completed" ||
      (typeof result.exitCode === "number" && result.exitCode !== 0)
    ) {
      throw new Error(`${label}: ${result?.error || "command failed"}`);
    }
    return result.output || "";
  }

  async function onPhone(command) {
    return completed(await shell(command, phoneOptions), command);
  }

  async function onGsv(command) {
    return completed(await shell(command), command);
  }

  async function pause(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function screenshot(label, maxDimension) {
    const path = `/tmp/codemode-spotify-${label}-${Date.now()}.png`;
    const scale = maxDimension ? ` --max-dimension ${maxDimension}` : "";
    const capture = JSON.parse(
      await onPhone(`screen screenshot ${JSON.stringify(path)}${scale}`),
    );
    frames.push(path);
    if (capture.size < 64 * 1024) {
      throw new Error(
        `Display capture is suspiciously small (${capture.size} bytes); wake and unlock the phone`,
      );
    }
    return path;
  }

  async function detect(path, target) {
    const output = await onGsv(
      `img2txt detect --target ${
        JSON.stringify(target)
      } --max-objects 8 ${phone}:${path}`,
    );
    const parsed = JSON.parse(output);
    return Array.isArray(parsed.objects) ? parsed.objects : [];
  }

  function edge(box, camel, snake) {
    const result = box[camel] === undefined ? box[snake] : box[camel];
    if (typeof result !== "number") {
      throw new Error(`Grounding result omitted ${camel}`);
    }
    return result;
  }

  function center(box) {
    return {
      x: (edge(box, "xMin", "x_min") + edge(box, "xMax", "x_max")) / 2,
      y: (edge(box, "yMin", "y_min") + edge(box, "yMax", "y_max")) / 2,
    };
  }

  function within(box, bounds) {
    const point = center(box);
    return point.x >= bounds.xMin && point.x <= bounds.xMax &&
      point.y >= bounds.yMin && point.y <= bounds.yMax;
  }

  function inRegion(boxes, bounds) {
    return boxes.filter((box) => within(box, bounds));
  }

  async function tap(point, display) {
    const x = Math.max(
      0,
      Math.min(display.width - 1, Math.round(point.x * display.width)),
    );
    const y = Math.max(
      0,
      Math.min(display.height - 1, Math.round(point.y * display.height)),
    );
    await onPhone(`input tap ${x} ${y}`);
    return { x, y };
  }

  function topmost(boxes) {
    return boxes.sort(
      (left, right) =>
        edge(left, "yMin", "y_min") - edge(right, "yMin", "y_min"),
    )[0];
  }

  function bottommost(boxes) {
    return boxes.sort(
      (left, right) =>
        edge(right, "yMax", "y_max") - edge(left, "yMax", "y_max"),
    )[0];
  }

  const report = { query, song, artist };

  try {
    const display = JSON.parse(await onPhone("screen status"));
    const screenHelp = await onPhone("help screen");
    const maxDimension = screenHelp.includes("--max-dimension") ? 1024 : null;
    report.display = { width: display.width, height: display.height };
    report.captureMaxDimension = maxDimension || 2048;
    report.onDeviceScaling = maxDimension !== null;

    await onPhone("apps open com.spotify.music");
    await pause(1500);

    let frame = await screenshot("initial", maxDimension);
    let searchBoxes = inRegion(
      await detect(
        frame,
        "Search tab button in the bottom navigation bar of Spotify",
      ),
      { xMin: 0, xMax: 1, yMin: 0.8, yMax: 1 },
    );
    if (searchBoxes.length === 0) {
      await onPhone("input key BACK");
      await pause(800);
      frame = await screenshot("after-back", maxDimension);
      searchBoxes = inRegion(
        await detect(
          frame,
          "Search tab button in the bottom navigation bar of Spotify",
        ),
        { xMin: 0, xMax: 1, yMin: 0.8, yMax: 1 },
      );
    }
    if (searchBoxes.length === 0) {
      throw new Error("Could not visually locate Spotify Search");
    }
    report.searchTap = await tap(center(bottommost(searchBoxes)), display);
    await pause(900);

    frame = await screenshot("search", maxDimension);
    const fieldBoxes = inRegion(
      await detect(
        frame,
        "Spotify search text input field near the top of the screen",
      ),
      { xMin: 0.05, xMax: 0.95, yMin: 0, yMax: 0.25 },
    );
    if (fieldBoxes.length === 0) {
      throw new Error("Could not visually locate the Spotify search field");
    }

    const clearBoxes = inRegion(
      await detect(
        frame,
        "X shaped clear text button at the right end of the Spotify search field",
      ),
      { xMin: 0.65, xMax: 1, yMin: 0, yMax: 0.25 },
    );
    if (clearBoxes.length > 0) {
      const clear = clearBoxes.sort(
        (left, right) =>
          edge(right, "xMax", "x_max") - edge(left, "xMax", "x_max"),
      )[0];
      report.clearTap = await tap(center(clear), display);
      await pause(500);
    }

    report.fieldTap = await tap(center(topmost(fieldBoxes)), display);
    await pause(400);
    await onPhone(`input text ${JSON.stringify(query)}`);
    await pause(1600);

    frame = await screenshot("results", maxDimension);
    const resultBoxes = inRegion(
      await detect(
        frame,
        `song result row titled ${song} by ${artist}, not an album or playlist`,
      ),
      { xMin: 0, xMax: 1, yMin: 0.12, yMax: 0.8 },
    );
    if (resultBoxes.length === 0) {
      throw new Error("Could not visually locate the exact song result");
    }
    report.resultTap = await tap(center(topmost(resultBoxes)), display);
    await pause(1800);

    frame = await screenshot("playing", maxDimension);
    const playingBoxes = inRegion(
      await detect(
        frame,
        `mini player showing ${song} by ${artist} near the bottom of Spotify`,
      ),
      { xMin: 0, xMax: 1, yMin: 0.75, yMax: 1 },
    );
    if (playingBoxes.length === 0) {
      throw new Error(
        "Song tap completed but visual playback verification failed",
      );
    }
    report.playingGrounding = center(bottommost(playingBoxes));
    report.verified = true;
    return report;
  } finally {
    for (const path of frames) {
      try {
        await onPhone(`rm -f ${JSON.stringify(path)}`);
      } catch {}
    }
  }
};

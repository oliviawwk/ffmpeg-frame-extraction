const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs-extra");

const streams = {};

module.exports = {
  create: create,
  stop: stop
};

function create(monitor, url) {
  const id = monitor.id;

  if (streams[id]) {
    return;
  }

  if (!url || url === "") {
    return;
  }

  console.log("Starting " + id);
  streams[id] = {
    lastFrameEnqueued: 0,
    monitor,
    url
  };

  const frameDir = `frames/${id}`;
  const hlsDir = `hls/${id}`;
  fs.ensureDirSync(frameDir);
  fs.ensureDirSync(hlsDir);
  fs.emptyDirSync(frameDir);
  fs.emptyDirSync(hlsDir);
  let ffmpegProcess = ffmpeg(url)
    .on("start", function(commandLine) {
      console.log("Spawned Ffmpeg with command: " + commandLine);
    })
    .on("progress", function(progress) {
      var n = streams[id].lastFrameEnqueued + 1;
      streams[id].lastFrameEnqueued = progress.frames - 1;
      for (; n < progress.frames; n++) {
        if (n > 30) {
          enqueueFrame(n - 30);
        }
      }
    })
    .on("error", err => {
      console.log("Error occured, checking type");
      console.log(err.message);
      if (err.message.indexOf("SIGKILL") === -1) {
        console.log("Stream for " + id + " is in error");
        console.log("Recreating in 1s");
        setTimeout(() => {
          create(monitor, url);
          delete streams[id];
          console.log("Delete Stream");
          stopRecord(id);
        }, 1000);
      } else {
        console.log("Stream for " + id + " is killed");
      }
    })
    .output(`${frameDir}/frame.jpg`)
    .fps(30)
    .size("640x360")
    .outputOptions(["-vf fps=1", "-update 1"]);
  streams[id].ffmpegProcess = ffmpegProcess;
  ffmpegProcess.run();

  async function enqueueFrame(number) {
    // do something with frame<number>.jpg
    try {
      if (number % 60 === 0) {
        const data = await fs.readFile(`${frameDir}/frame.jpg`);
      }
    } catch (err) {
      // console.log(err);
    }
  }
}

function stop(id) {
  if (streams[id] && streams[id].ffmpegProcess) {
    console.log("Stopping");
    streams[id].ffmpegProcess.kill();
    console.log("Killed FFMPEG");
    delete streams[id];
    console.log("Delete Stream");
    stopRecord(id);
  }
}
function getAll() {
  return streams;
}

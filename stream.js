const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs-extra");
const aws = require("./lib/aws");
const draw = require("./lib/draw");
const { transferFrames } = require("./frame");
const s3 = new aws.S3({});
const axios = require("axios");

const streams = {};

module.exports = {
  create: create,
  stop: stop,
  record: record,
  stopRecord: stopRecord,

  set,
  get,

  uploadFlv,
  doRecord,
  getAll
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
    // .output(`${hlsDir}/stream.m3u8`)
    // .outputOptions([
    //   "-f hls",
    //   "-codec: copy",
    //   "-hls_time 10",
    //   "-hls_list_size 3",
    //   "-hls_flags +delete_segments+omit_endlist"
    // ])
    .noAudio()
    .format("flv")
    .output(`rtmp://rtmp.customindz.com/live/` + id)
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
        await delay(200);
        const data = await fs.readFile(`${frameDir}/frame.jpg`);
        let frameTimestamp = new Date().getTime();
        let params = {
          ACL: "public-read",
          Bucket: "customindz-shinobi",
          Key: `${frameDir}/latest.jpg`,
          Body: data
        };
        await s3.putObject(params).promise();
        // console.log(
        //   "Successfully uploaded data to customindz-shinobi/" +
        //     `${frameDir}/latest.jpg`
        // );
        const detection = await transferFrames(streams[id].monitor, data);
        // console.log(detection);
        // console.log("Detection Result Get, Start drawing");
        await draw.rects(`${frameDir}/frame.jpg`, detection);
        // console.log("Draw Complete, Uploading");
        const detectionData = await fs.readFile(
          `${frameDir}/frame-detection.jpg`
        );
        let paramsDetection = {
          ACL: "public-read",
          Bucket: "customindz-shinobi",
          Key: `${frameDir}/latest-detection.jpg`,
          Body: detectionData
        };
        await s3.putObject(paramsDetection).promise();
        // console.log(
        //   "Successfully uploaded data to customindz-shinobi/" +
        //     `${frameDir}/latest-detection.jpg`
        // );
        // await fs.remove(`${frameDir}/frame.jpg`);
        // await fs.remove(`${frameDir}/frame-detection.jpg`);
      } else {
        // console.log("Removing " + number);
        // await fs.remove(`${frameDir}/frame.jpg`);
        // console.log("Removing for free up space");
      }
      //
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

function record(id) {
  if (!streams[id] || !streams[id].url) {
    return;
  }
  fs.ensureDirSync(`records/${id}`);
  let videoTimestamp = new Date().getTime();
  if (!streams[id].recordProcess) {
    console.log("Start Record");
    streams[id].recordProcess = doRecord(streams[id].url, id, videoTimestamp);
    streams[id].recordProcess.run();
  }
}

function stopRecord(id) {
  if (streams[id] && streams[id].recordProcess) {
    console.log("Stop Record");
    streams[id].recordProcess.kill();
    delete streams[id].recordProcess;
  }
}

function get(id) {
  return streams[id];
}

function set(id, monitor) {
  if (streams[id]) {
    streams[id].monitor = monitor;
  }
}

function delay(time) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve();
    }, time);
  });
}

async function uploadFlv(id, videoTimestamp) {
  const data = await fs.readFile(`records/${id}/${videoTimestamp}.flv`);
  console.log("Got video data");
  const params = {
    ACL: "public-read",
    Bucket: "customindz-shinobi",
    Key: `records/${id}/${videoTimestamp}.flv`,
    Body: data
  };
  await s3.putObject(params).promise();
  console.log("Finish video upload");
  // Prepare a copy of thumbnail
  const copyParams = {
    ACL: "public-read",
    Bucket: "customindz-shinobi",
    Key: `records/${id}/${videoTimestamp}.jpg`,
    CopySource: `customindz-shinobi/frames/${id}/latest.jpg`
  };
  await s3.copyObject(copyParams).promise();
  console.log("Finish thumbnail upload");
  console.log(
    "Successfully uploaded data to " + `records/${id}/${videoTimestamp}.flv`
  );
  await fs.remove(`records/${id}/${videoTimestamp}.flv`);
  console.log("Removed local flv");
  const vod = {
    monitor_id: id,
    flv_url: `records/${id}/${videoTimestamp}.flv`,
    thumbnail_url: `records/${id}/${videoTimestamp}.jpg`,
    timestamp: parseInt(videoTimestamp)
  };
  console.log(JSON.stringify(vod));
  await axios.post("https://api.customindz.com/api/admin/vod", vod, {
    headers: {
      "x-customindz-key": "customindz"
    }
  });
}

function doRecord(url, id, timestamp) {
  return ffmpeg(url)
    .on("start", function(commandLine) {
      console.log("Spawned Ffmpeg with command: " + commandLine);
    })
    .on("error", async err => {
      // console.log("Record stream for " + id + " is killed");
      // console.log("Starting upload");
      // upload;
      console.log(err);
      try {
        await uploadFlv(id, timestamp);
        // console.log("Added VOD to database");
        // post new vod to endpoint
      } catch (err) {
        // console.log(err);
      }
    })
    .audioCodec("aac")
    .videoCodec("libx264")
    .output(`records/${id}/${timestamp}.flv`);
}

function getAll() {
  return streams;
}

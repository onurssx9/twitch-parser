// @flow

import path from 'path';
import fse from 'fs-extra';
import Bluebird from 'bluebird';

import createEventManager, { type Events } from './createEventManager';
import FfmpegHelper from './FfmpegHelper';
import downloadFile from './downloadFile';
import getClips, { type TwitchClip } from './getClips';
import getTwitchClipVideoUrl from './getTwitchClipVideoUrl';
import buildDescription from './buildDescription';

type Configuration = {
  size: number,
  period: 'day',
  language: string,
  trending: boolean,
  game: string,
  ffmpegCommand: string,
  introVideoPath: string,
  separatorVideoPath: string,
  outroVideoPath: string,
  tempDirectory: string,
  outputDirectory: string,
};

type CompilationResult = $ReadOnly<{|
  clips: $ReadOnlyArray<TwitchClip>,
  elapsedTime: number,
|}>;

type TwitchVideoCompiler = $ReadOnly<{|
  compile: () => Promise<CompilationResult>,
  events: Events,
|}>;

export default function createTwitchVideoCompiler(
  configuration: Configuration,
): TwitchVideoCompiler {
  // Setup event manager
  const eventManager = createEventManager();

  // Setup compile
  const compile = async () => {
    const {
      ffmpegCommand,
      outputDirectory,
      introVideoPath,
      separatorVideoPath,
      outroVideoPath,
      tempDirectory,
    } = configuration;

    // Setup FfmpegHelper
    const ffmpegHelper = new FfmpegHelper(ffmpegCommand);

    const startTime = Date.now();

    eventManager.send({ name: 'fetchingClips' });

    const clips = await getClips({
      limit: configuration.size,
      language: configuration.language,
      period: configuration.period,
      trending: configuration.trending,
      game: configuration.game,
    });

    eventManager.send({ name: 'preparingVideos' });

    await fse.ensureDir(outputDirectory);
    await fse.ensureDir(tempDirectory);

    const transcodedVideos = await Bluebird.map(
      clips,
      async (clip) => {
        // Download
        eventManager.send({ name: 'downloadingClip', clip });

        const url = getTwitchClipVideoUrl(clip);
        const downloadPath = path.join(outputDirectory, `./${clip.id}.mp4`);
        if (!(await fse.exists(downloadPath))) {
          await downloadFile(url, downloadPath);
        }

        // Transcode
        eventManager.send({ name: 'transcodingClip', clip });

        const outputPath = path.join(tempDirectory, `./${clip.id}_transcoded.mp4`);
        if (!(await fse.exists(outputPath))) {
          await ffmpegHelper.transcodeVideo(downloadPath, outputPath);
        }

        return {
          clip,
          path: outputPath,
        };
      },
      {
        concurrency: 5,
      },
    );

    eventManager.send({ name: 'generatingCompilation' });

    const files = [introVideoPath];

    transcodedVideos.forEach((tv, index) => {
      if (index > 0) {
        files.push(separatorVideoPath);
      }

      files.push(tv.path);
    });

    files.push(outroVideoPath);

    const outputPath = path.join(outputDirectory, './output.mp4');

    await ffmpegHelper.concatVideos(files, outputPath);

    // Write Description
    const elapsedTime = Date.now() - startTime;
    const description = buildDescription(configuration, clips, elapsedTime);
    const descriptionPath = path.join(outputDirectory, './description.txt');

    await fse.writeFile(descriptionPath, description);

    eventManager.send({ name: 'complete', clips, elapsedTime });

    return {
      clips,
      elapsedTime,
    };
  };

  return {
    compile,
    events: eventManager.events,
  };
}

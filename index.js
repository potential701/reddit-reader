import dotenv from 'dotenv';
import fs, { readFile, writeFile } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import {
  createServiceClient,
  createStorageClient,
} from './supabase/service_role.js';
import Creatomate from 'creatomate';
import { Movie, Scene } from 'json2video-sdk';
import { audioToSlice } from 'audio-slicer';

dotenv.config();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = await createServiceClient();
const storage = await createStorageClient();
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const client = new Creatomate.Client(process.env.CREATOMATE_API_KEY);

const username = process.env.REDDIT_USERNAME;
const password = process.env.REDDIT_PASSWORD;
const clientId = process.env.REDDIT_CLIENT_ID;
const secret = process.env.REDDIT_SECRET;

async function getAccessToken() {
  const headers = { Authorization: `Basic ${btoa(clientId + ':' + secret)}` };

  const request = await fetch(
    `https://www.reddit.com/api/v1/access_token?grant_type=password&username=${username}&password=${password}`,
    {
      method: 'POST',
      headers: headers,
    }
  );
  const response = await request.json();
  return response.access_token;
}

async function getPosts(subreddit, sort, time, limit) {
  const token = await getAccessToken();

  const request = await fetch(
    `https://oauth.reddit.com/r/${subreddit}/${sort}?t=${time}&limit=${limit}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const response = await request.json();

  return getPostsFromResponse(response);
}

function getPostsFromResponse(response) {
  let posts = [];
  for (let i = 0; i < response.data.children.length; i++) {
    posts.push({
      title: String(response.data.children[i].data.title).trim(),
      text: String(response.data.children[i].data.selftext).trim(),
    });
  }

  return posts;
}

function textToFile(text, fileName) {
  fs.writeFile(
    `/Users/potential701/Documents/posts/${fileName}.txt`,
    text,
    (err) => {
      if (err) {
        console.log(err);
      } else {
        console.log('File written successfully');
      }
    }
  );
}

async function textToSpeech(model, voice, input) {
  const tts = await openai.audio.speech.create({
    model: model,
    voice: voice,
    input: input,
  });

  return tts;
}

async function speechToBuffer(speech) {
  const buffer = Buffer.from(await speech.arrayBuffer());
  return buffer;
}

async function fileToStorage(filePath, file) {
  const { data: upload } = await storage
    .from('audio')
    .upload(filePath, file, { contentType: 'audio/mp3' });

  const { data: url } = storage.from('audio').getPublicUrl(filePath);

  return url.publicUrl;
}

async function getVideoUrlsFromStorage() {
  let urls = [];
  const { data } = await storage.from('video').list();
  console.log(data);
  for (let i = 0; i < data.length; i++) {
    const { data: url } = storage.from('video').getPublicUrl(data[i].name);
    urls.push(url.publicUrl);
  }

  return urls;
}

async function deleteFileFromStorage(bucket, fileUrl) {
  await storage.from(bucket).remove(String(fileUrl).split('/').at(-1));
}

async function transcribeUrl(url) {
  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    { url: url },
    { model: 'nova-2', smart_format: true }
  );
  return result.results.channels[0].alternatives[0].words;
}

async function sendDiscordMessage(title, url) {
  await fetch(
    'https://discord.com/api/webhooks/1252617605081075784/KdVYF62osKLfffqreN67d4noCSlRTHlWAo7ThanM_sXFzDgypEh8ZicVZb6x3vAWyVUZ',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `${title},${url}` }),
    }
  );
}
async function compileScene(audioUrl, videoUrl, words) {
  let scene = new Scene();

  words.forEach((word) => {
    scene.addElement({
      type: 'text',
      text: word.punctuated_word,
      duration: word.end - word.start,
      start: word.start,
      settings: {
        'font-family': 'Playfair Display',
        'font-weight': '800',
        'font-size': '68px',
      },
    });
  });

  scene.addElement({
    type: 'audio',
    src: audioUrl,
  });

  scene.addElement({
    type: 'video',
    src: videoUrl,
    duration: words.at(-1).end,
    scale: { width: 1920, height: 1080 },
    y: 540,
  });

  return scene;
}

async function renderScene(scene, title, index) {
  let movie = new Movie();
  movie.setAPIKey(process.env.JSON2VIDEO_API_KEY);
  movie.set('quality', 'high');
  movie.set('width', 1080);
  movie.set('height', 1920);

  movie.addScene(scene);

  let render = await movie.render();
  console.log(render);

  await movie
    .waitToFinish((status) => {
      console.log(
        'Rendering: ',
        status.movie.status,
        ' / ',
        status.movie.message
      );
      console.log(status);
    })
    .then(async (status) => {
      console.log('Response: ', status);
      console.log('Movie is ready: ', status.movie.url);
      await sendDiscordMessage(title + ' Pt. ' + index, status.movie.url);
    })
    .catch((err) => {
      console.log('Error: ', err);
    });
}

const posts = [
  {
    title: 'test',
    text: 'Hello, world! This is a test post. There is nothing interesting in this post. It is boring. Bye.',
  },
];

for (let j = 0; j < posts.length; j++) {
  console.log(posts[j].title);
  console.log(posts[j].text.length);
  const tts = await textToSpeech('tts-1', 'onyx', posts[j].text);
  const audioBuffer = await speechToBuffer(tts);
  const splitAudioBuffers = await audioToSlice(audioBuffer, 40, false);
  const videoUrls = await getVideoUrlsFromStorage();
  for (let i = 0; i < splitAudioBuffers.length; i++) {
    const videoUrl = videoUrls.shift();
    const audioUrl = await fileToStorage(
      uuidv4() + '.mp3',
      splitAudioBuffers[i]
    );
    const transcriptWords = await transcribeUrl(audioUrl);
    const scene = await compileScene(audioUrl, videoUrl, transcriptWords);
    await renderScene(scene, posts[j].title, i + 1);
    await deleteFileFromStorage('audio', audioUrl);
    // await deleteFileFromStorage('video', videoUrl);
  }
}

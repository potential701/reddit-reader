import dotenv from 'dotenv';
import fs, { readFile, writeFile } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { createClient } from '@deepgram/sdk';
import { createServiceClient, createStorageClient } from './supabase/service_role.js';
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

	const request = await fetch(`https://www.reddit.com/api/v1/access_token?grant_type=password&username=${username}&password=${password}`, {
		method: 'POST',
		headers: headers,
	});
	const response = await request.json();
	return response.access_token;
}

async function getPosts(subreddit, sort, time, limit) {
	const token = await getAccessToken();

	const request = await fetch(`https://oauth.reddit.com/r/${subreddit}/${sort}?t=${time}&limit=${limit}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
	});
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
	fs.writeFile(`/Users/potential701/Documents/posts/${fileName}.txt`, text, (err) => {
		if (err) {
			console.log(err);
		} else {
			console.log('File written successfully');
		}
	});
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
	const { data: upload } = await storage.from('audio').upload(filePath, file, { contentType: 'audio/mp3' });

	const { data: url } = storage.from('audio').getPublicUrl(filePath);

	return url.publicUrl;
}

async function getVideoUrlsFromStorage() {
	let urls = [];
	const { data } = await storage.from('video').list();
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
	const { result, error } = await deepgram.listen.prerecorded.transcribeUrl({ url: url }, { model: 'nova-2', smart_format: true });
	return result.results.channels[0].alternatives[0].words;
}

async function sendDiscordMessage(title, url) {
	await fetch('https://discord.com/api/webhooks/1252617605081075784/KdVYF62osKLfffqreN67d4noCSlRTHlWAo7ThanM_sXFzDgypEh8ZicVZb6x3vAWyVUZ', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ content: `${title}||${url}` }),
	});
}
async function compileScene(audioUrl, videoUrl, sentences) {
	let scene = new Scene();

	scene.addElement({
		type: 'audio',
		src: audioUrl,
	});

	scene.addElement({
		type: 'video',
		src: videoUrl,
		duration: sentences.at(-1).end,
		muted: true,
	});

	for (let i = 0; i < sentences.length; i++) {
		scene.addElement({
			type: 'text',
			text: sentences[i].punctuated_word,
			duration: sentences[i].end - sentences[i].start,
			start: sentences[i].start,
			width: 940,
			x: 70,
			settings: {
				'font-family': 'Playfair Display',
				'font-weight': '800',
				'font-size': '68px',
				'text-shadow': '2px 2px 2px rgba(0,0,0,0.8)',
				'text-align': 'center',
			},
		});
	}

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
			console.log('Rendering: ', status.movie.status, ' / ', status.movie.message);
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

function wordsToSentences(words) {
	let sentences = [];
	let sentence = { punctuated_word: '', start: 0, end: 1 };
	for (let i = 0; i < words.length; i++) {
		if (Math.abs(sentence.end) - Math.abs(sentence.start) >= 3) {
			sentences.push(sentence);
			sentence = { punctuated_word: '', start: 0, end: 0 };
			sentence.start = words[i].start;
		}
		sentence.punctuated_word += words[i].punctuated_word + ' ';
		sentence.end = words[i].end;
	}
	sentences.push(sentence);

	return sentences;
}

async function generateStoryPosts(subreddit, sort, time, limit) {
	const posts = (await getPosts(subreddit, sort, time, limit)).filter((x) => x.text.length <= 4096 && x.text.length >= 1024).reverse();

	// const posts = [
	// 	{
	// 		title: "Doctors of Reddit, who's the dumbest patient you've ever had? Part 2...",
	// 		text: "Doctors of Reddit, who's the dumbest patient you've ever had? Part 2... This doesn't exactly fit the criteria, but it's close.\n\nNot a doctor, I'm a nurse. And not a patient, family members.\n\nBack when I still worked in the ICU I had a family come in during visitation to see their loved one carrying one of those plastic containers from a grocery store bakery with half a dozen cupcakes inside. Not unusual, families would bring us food all the time and it was incredibly nice and we always appreciated it. Nope. I walked into the room to update them on the patient and we talked about it also being her birthday that day. They gestured toward the cupcakes and said that's why they had the cupcakes with them. I thought that was really sweet, they were going to celebrate her birthday with her even though she was in the ICU. Then they hand me the container and look at me expectantly. I look back, unsure of what my next move was supposed to be.\n\n\"Aren't you going to feed them to her?\"\n\nThis woman was on a ventilator and on IV sedation.\n\nIt took me an embarrassingly long time to explain to these people why she couldn't eat while she was unconscious with a breathing tube in. Nice folks, not terribly bright.\n';",
	// 	},
	// ];

	for (let j = 0; j < 1; j++) {
		console.log(posts[j].title);
		console.log(posts[j].text.length);
		const tts = await textToSpeech('tts-1', 'onyx', posts[j].text);
		const audioBuffer = await speechToBuffer(tts);
		const splitAudioBuffers = await audioToSlice(audioBuffer, 59, false);
		console.log('videos: ', splitAudioBuffers.length);
		const videoUrls = (await getVideoUrlsFromStorage()).filter((x) => x.includes('mp4'));
		for (let i = 0; i < splitAudioBuffers.length; i++) {
			const videoUrl = videoUrls.shift();
			const audioUrl = await fileToStorage(uuidv4() + '.mp3', splitAudioBuffers[i]);
			const transcriptWords = await transcribeUrl(audioUrl);
			const sentences = wordsToSentences(transcriptWords);
			const scene = await compileScene(audioUrl, videoUrl, sentences);
			await renderScene(scene, posts[j].title, i + 1);
			await deleteFileFromStorage('audio', audioUrl);
			await deleteFileFromStorage('video', videoUrl);
		}
	}
}

await generateStoryPosts('scarystories', 'hot', 'all', 2, 1);

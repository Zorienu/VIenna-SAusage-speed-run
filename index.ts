import axios from 'axios';
import qs from 'qs'
import fs from 'fs'
import {DateTime} from 'luxon';
import twilio from 'twilio';
import cron from 'node-cron';

const url = 'https://ais.usvisa-info.com';
const loginUrl = `${url}/es-co/niv/users/sign_in`;

const regex = /_yatri_session=([^;]+)/
const csrfTokenRegex = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i

const statusCodeToRetry = ['502']

let config: {yatri: string, csrf: string, meetDate: string, email: string, password: string, phone: string, twilioAccountSid: string, twilioAuthToken: string, twilioMessagingServiceSid: string } | undefined = undefined;

const baseHeaders = {
	'Accept': '*/*;q=0.5, text/javascript, application/javascript, application/ecmascript, application/x-ecmascript',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Connection': 'keep-alive', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://ais.usvisa-info.com',
        'Referer': 'https://ais.usvisa-info.com/es-co/niv/users/sign_in',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
}


function getSession(response: any): {yatri: string, csrf: string} {
	const session =	response.headers['set-cookie'][0]
	const csrfToken = response.data.match(csrfTokenRegex)?.[1] || config.csrf;
	return { yatri: session.match(regex)[1], csrf: csrfToken }
}

async function getFirstSession() {
	const firstRequest = await axios.get(loginUrl, { 
  		"headers": {
		    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
		    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
		    "cache-control": "max-age=0",
		    "sec-ch-ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Google Chrome\";v=\"134\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Linux\"",
		    "sec-fetch-dest": "document",
		    "sec-fetch-mode": "navigate",
		    "sec-fetch-site": "none",
		    "sec-fetch-user": "?1",
		    "upgrade-insecure-requests": "1"
		},
 	});
	const session = getSession(firstRequest);
	console.log('First yatri session: ', session);
	return session;
}

async function login() {
	const firstSession = await getFirstSession();
	const response = await axios.post('https://ais.usvisa-info.com/es-co/niv/users/sign_in', qs.stringify({
		'user[email]': config.email,
    		'user[password]': config.password,
    		'policy_confirmed': '1',
    		'commit': 'Iniciar sesión',
	}),
	{
		headers: {
			...baseHeaders,
			Cookie: `_yatri_session=${firstSession.yatri}`,
			'X-CSRF-Token': firstSession.csrf,
		},
		withCredentials: true,
		maxRedirects: 5, // to replicate `-L` behavior
	})

	const session = getSession(response);
	console.log('Session: ', session);

	setConfigValue('csrf', session.csrf);
	setConfigValue('yatri', session.yatri);
}

async function getDates(): Promise<string[]>{
	try {
		const response = await axios.get('https://ais.usvisa-info.com/es-co/niv/schedule/67530133/appointment/days/25.json', {
			params: {
			  'appointments[expedite]': 'false',
			},
			headers: {
				...baseHeaders,
				Cookie: `_yatri_session=${config.yatri}`,
					'X-CSRF-Token': config.csrf,
			}
		});


		return response.data.map((d:{date: string})=> d.date).slice(0, 5);
	} catch(error) {
		console.log('ERROR', error)
		const errorMessage = error.response.data.error
		if (errorMessage === 'Your session expired, please sign in again to continue.') {
			console.log('here')
			await login();
			return await getDates();
		}
		else {
			throw error;
		}
	}

}

function loadConfig() {
	config = JSON.parse(fs.readFileSync('config.json').toString())
}

function setConfigValue(key: keyof typeof config, value: string) {
	config[key] = value;
	fs.writeFileSync('config.json', JSON.stringify(config, null, 2))
}

function shouldAlert(closestDate: string): boolean {
	if (!closestDate) return false;
	const currentMeetDateTime = DateTime.fromISO(config.meetDate);
	const nearestAvailableDateTime = DateTime.fromISO(closestDate);
	return nearestAvailableDateTime < currentMeetDateTime;
}

async function alert(date: string) {
	const client = require('twilio')(config.twilioAccountSid, config.twilioAuthToken);
	await client.messages.create({
		body: `Nueva fecha! (Nueva: ${date}, Vieja: ${config.meetDate})`,
		messagingServiceSid: config.twilioMessagingServiceSid,
		to:config.phone
    	})
}
	

async function main() {
	loadConfig()
	await login();
	const dates = await getDates();
	const closestDate = dates[0]
	const shouldBeAlerted = shouldAlert(closestDate);
	console.log('Available dates: ', dates);
	console.log('Should alert? ', shouldBeAlerted ? 'yes' : 'no');
	shouldBeAlerted && await alert(closestDate)
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
cron.schedule('0 */2 * * *', async () => {
	const delayInMs = Math.random() * 3_600_000;
	console.log('Delaying by ', delayInMs / 1000, ' seconds');
	await delay(delayInMs);
	await main();
});

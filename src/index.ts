import { IncomingMessage, ServerResponse } from 'http'
import { URL, parse } from 'url'
import { get } from 'https'

//
// Define our expected data formats:
//
interface HourlyForecast {
  temperature: number,
  feels_like: number,
  precipitation_probability: number
}

interface Forecast {
  alerts: string[],
  temperature: number,
  feels_like: number,
  current_summary: string,
  future_summary: string,
  hourly: HourlyForecast[]
}

interface LatLng {
  latitude: number,
  longitude: number
}

const enum Format {
  html,
  tty
}

/**
 * For a given HTTPS URL, fetch the JSON on the other end. Not a very smart
 * function, so don't ask it to do too much.
 *
 * @param url
 */
function fetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    get(url, res => {
      if (res.statusCode !== 200) reject(new Error(`${url}: ${res.statusCode} ${res.statusMessage}`))

      res.setEncoding('utf8')
      let rawData = ''
      res.on('data', chunk => {
        rawData += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(rawData))
        } catch (e) {
          reject(e)
        }
      })
      res.on('error', e => reject(e))
    }).on('error', e => {
      reject(e)
    })
  })
}

/**
 * For the given zip code get the latitude/longitude of the centroid of the
 * zip code tabulation area (I assume? Who even knows about SmartyStreets)
 *
 * @param context
 * @param zipcode
 */
async function getLatLngForZipCode(context: any, zipcode: string): Promise<LatLng> {
  const url = new URL('lookup', 'https://us-zipcode.api.smartystreets.com')
  url.searchParams.append('auth-id', context.secrets.SMARTYSTREETS_KEY)
  url.searchParams.append('auth-token', context.secrets.SMARTYSTREETS_TOKEN)
  url.searchParams.append('zipcode', zipcode)

  const data = await fetch(url.toString())

  return {
    latitude: data[ 0 ].zipcodes[ 0 ].latitude as number,
    longitude: data[ 0 ].zipcodes[ 0 ].longitude as number,
  }
}


/**
 * Transforms a darksky.net forecast into something we can work with more
 * easily.
 *
 * @param data
 */
function transformDarkSkyForecast (data: any): Forecast {
  return {
    alerts: data.alerts ? data.alerts.map((a: any) => a.title as string) : [],
    temperature: data.currently.temperature as number,
    feels_like: data.currently.apparentTemperature as number,
    current_summary: data.currently.summary as string,
    future_summary: data.hourly.summary as string,
    hourly: data.hourly.data.slice(0, 25).map((hour: any) => ({
      temperature: hour.temperature as number,
      feels_like: hour.apparentTemperature as number,
      precipitation_probability: hour.precipProbability as number,
    })),
  }
}

/**
 * For a given lat/lng, fetch the forecast from Dark Sky for that point
 *
 * @param latitude
 * @param longitude
 */
async function getForecastForLatLng(context: any, latitude: number, longitude: number): Promise<Forecast> {
  const url = `https://api.darksky.net/forecast/${context.secrets.DARK_SKY_SECRET}/${latitude},${longitude}`
  return transformDarkSkyForecast(await fetch(url))
}

/**
 * For a given zip code, get the actual geographic position, then get the
 * forecast for that position.
 *
 * @param context
 * @param zipcode
 */
async function getForecastForZipCode(context: any, zipcode: string): Promise<Forecast> {
  // If the zip code is 02130, Jamaica Plain MA, use the memoized forecast
  // object above. This is to avoid overrunnig the low-ish rate limits on
  // both SmartyStreets and Dark Sky.
  //
  if (zipcode === '02130') {
    return transformDarkSkyForecast(MEMOIZED_FORECAST)
  } else {
    const { latitude, longitude } = await getLatLngForZipCode(context, zipcode)
    return getForecastForLatLng(context, latitude, longitude)
  }
}

/**
 * Makes the contained text bold. If the format is html, it will use the
 * <strong> tag. If the format is tty, it will use the "bright" command
 * code.
 *
 * @param s
 * @param format
 */
function bold(s: string, format: Format) {
  if (format === Format.html) {
    return `<strong>${s}</strong>`
  } else {
    return `\x1b[1m${s}\x1b[0m`
  }
}

/**
 * Makes the contained text cyan. If the format is HTML, it will use a
 * <span> tag with a style set. If the format is tty, it will use the
 * "cyan" command code.
 *
 * @param s
 * @param format
 */
function cyan(s: string, format: Format) {
  if (format === Format.html) {
    return `<span style="color: teal">${s}</span>`
  } else {
    return `\x1b[36m${s}\x1b[0m`
  }
}

/*
Warning: Many ugly for loops ahead.

The rationale for using for loops instead of map/reduce, which would normally
be my preference, is twofold:

- In some cases, I need to move the index cursor around dynamically based on
  what data I'm adding to the output "buffer" of each function. I can't do
  that with map/reduce, so a for loop becomes the obvious choice.
- In the cases where I don't need to move the cursor around, I need to act
  "horizontally" on an array of data: so instead of transforming each record
  in a list to some other value, I need to look at each item in the list to
  determine if I want to render an asterisk or a blank space.

  An alternative approach to solving this specific problem would be to write
  a function that takes a list of numbers and "integrates" it into a 2d
  matrix of true/false cells. Rendering then becomes a nested map. I decided
  not to go that route because it seemed too-clever for the limited use case
  in front of me. -- Nick
*/

// The graph is prefixed by several blank characters where we can optionally
// stick some labels. This defines that prefix:
const PREFIX = ' '.repeat(9)
const PREFIX_LEN = PREFIX.length

/**
 * Renders a precipitation graph in ASCII.
 *
 * This graph "hangs" below the temperature graph.
 * As the percent chance of precipitation increases, the bar height also
 * increases, with zero being at the top and 100% being below.
 *
 * The graph appears in cyan to distinguish it from the temp graph.
 *
 * @param forecast
 * @param format
 */
function renderPrecipitationGraph(forecast: Forecast, format: Format): string {
  const graphHeight = 5

  function scalePrecipitation(precipitationProbability: number): number {
    return Math.round(precipitationProbability * graphHeight)
  }

  const precipProbabilities = forecast.hourly.map(h => h.precipitation_probability)
  const scaledPrecips = precipProbabilities.map(scalePrecipitation)
  const maxPrecipProbability = Math.max(...precipProbabilities)
  const result = []

  // If it's not going to rain, don't render anything:
  if (maxPrecipProbability === 0) return ''

  // For each row in the graph, starting at the top, render an asterisk if
  // the normalized probability of rain is greater than the index cursor
  // Otherwise render some empty space.
  //
  // When we hit the row that has the greatest chance of rain, render the
  // actual maximum probability.
  //
  for (let i = 1; i < graphHeight + 1; i += 1) {
    let prefix = PREFIX
    if (scalePrecipitation(maxPrecipProbability) === i) {
      prefix = cyan(bold(`    R ${Math.round(maxPrecipProbability * 100)}%  `.slice(-PREFIX_LEN), format), format)
    }
    result.push(prefix + cyan(scaledPrecips.map(p => p >= i ? '**' : '  ').join(''), format))
  }
  return result.join('\n')
}

/**
 * Renders a temperature graph based on the perceived temperature provided
 * in ASCII art.
 *
 * The graph marks the high and low, and is a relative representation of the
 * difference between high and low temps.
 *
 * @param forecast
 * @param format
 */
function renderTemperatureGraph(forecast: Forecast, format: Format): string {
  const graphHeight = 7
  const temps = forecast.hourly.map(h => h.feels_like)
  const maxTemperature = Math.max(...temps)
  const minTemperature = Math.min(...temps)

  function scaleTemperature(temp: number): number {
    return Math.round((temp - minTemperature) / (maxTemperature - minTemperature) * graphHeight)
  }

  const scaledTemps = temps.map(scaleTemperature)
  const result = []

  // Here, we work backwards: starting from the "bottom", render an asterisk
  // if the temperature is greater than the index cursor. Mark the high and
  // low temperature points at the top and bottom of the graph.
  //
  for (let i = graphHeight; i; i -= 1) {
    let prefix = PREFIX
    if (i === graphHeight) prefix = bold(`    H ${Math.round(maxTemperature)}F  `.slice(-PREFIX_LEN), format)
    result.push(prefix + scaledTemps.map(t => t >= i ? '**' : '  ').join(''))
  }

  result.push(
    bold((`    L ${Math.round(minTemperature)}F  `).slice(-PREFIX_LEN), format) + '**'.repeat(scaledTemps.length))

  return result.join('\n')
}

/**
 * Renders the time offset bit of the chart in 6-hour increments. Should
 * be flexible if the overall graph size changes.
 *
 * @param forecast
 * @param format
 */
function renderTimeOffsets(forecast: Forecast, format: Format): string {
  let result = PREFIX
  for (let i = 0; i < forecast.hourly.length; i += 1) {
    if (i === forecast.hourly.length - 1) {
      result += bold(`${forecast.hourly.length - 1}h`, format)
      break
    } else if (i % 6 === 0) {
      const marker = (`${i}h   `).slice(0, 4)
      i += 1
      result += bold(marker, format)
    } else {
      result += '  '
    }
  }
  return result
}

/**
 * Render the weather chart based on the forecast object provided. If the
 * format param is TTY, it will use ASCII command characters to provide
 * styling. If the format is HTML, it will use HTML tags instead.
 *
 * @param forecast
 * @param format
 */
function render(forecast: Forecast, format: Format): string {
  return [
    format === Format.html ? '<html><pre>' : '\n',
    forecast.alerts.length ? bold(`Alerts:  ${forecast.alerts.join(', ')}`, format) : undefined,
    bold(`Now:     ${Math.round(forecast.feels_like)}F, ${forecast.current_summary}`, format),
    bold(`Later:   ${forecast.future_summary}\n`, format),
    renderTimeOffsets(forecast, format),
    renderTemperatureGraph(forecast, format),
    renderPrecipitationGraph(forecast, format),
    format === Format.html ? '</pre></html>' : undefined,
  ].filter(v => v).join('\n') + '\n\n'
}

/**
 * The webtask entrypoint.
 *
 * @param context
 * @param request
 * @param response
 */
async function handler(context: any, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = parse(request.url as string, true)
    if (!url.query.zipcode) throw new Error(`Missing zipcode parameter`)
    if (Array.isArray(url.query.zipcode)) throw new Error(`Cannot specify multiple zipcodes`)
    const zipcode = url.query.zipcode

    // There's probably a better way to do this, but detect if the request
    // is being CURL'd or being requested by a browser. The browser will send
    // an accept header of `text/html, application/xhtml+xml, etc...` while a
    // curl will usually pass no accept header or an accept header of `*/*`
    //
    const format = request.headers.accept && request.headers.accept.includes('html')
      ? Format.html
      : Format.tty

    const forecast = await getForecastForZipCode(context, url.query.zipcode)

    response.writeHead(200, {
      'Content-Type': 'text/html',
    })

    response.end(render(forecast, format))
  } catch (e) {
    response.writeHead(500)
    response.end(e.message)
  }
}

export = handler

/*
Warning: Test data follows

The memoized forecast exists here for a couple reasons:

The first is that, for some reason, webtask.io kept forgetting the secrets
I had specified in the environment when I did a push. If you request the
zip code for the memoized forecast (02130), it will not attempt to request
data from Dark Sky or SmartyStreets and use the memoized data instead.

The second is that both Dark Sky and SmartyStreets have fairly onerous API
limits that I didn't want to collide with when testing. Bypassing their
APIs lets me test without racking up actual requests.

I was lucky in that Jamaica Plain, MA (02130) has some pretty interesting
weather coming today.
*/
const MEMOIZED_FORECAST = {
  'latitude': 42.3046576,
  'longitude': -71.1214454,
  'timezone': 'America/New_York',
  'currently': {
    'time': 1541799500,
    'summary': 'Overcast',
    'icon': 'cloudy',
    'nearestStormDistance': 15,
    'nearestStormBearing': 234,
    'precipIntensity': 0,
    'precipProbability': 0,
    'temperature': 47.37,
    'apparentTemperature': 44.28,
    'dewPoint': 37.57,
    'humidity': 0.69,
    'pressure': 1023.77,
    'windSpeed': 6.49,
    'windGust': 10.87,
    'windBearing': 87,
    'cloudCover': 1,
    'uvIndex': 0,
    'visibility': 10,
    'ozone': 246.3,
  },
  'minutely': {
    'summary': 'Drizzle starting in 50 min.',
    'icon': 'rain',
    'data': [ { 'time': 1541799480, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541799540,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541799600, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541799660,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541799720, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541799780,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541799840, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541799900,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541799960, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800020,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800080, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800140,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800200, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800260,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800320, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800380,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800440, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800500,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800560, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800620,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800680, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800740,
      'precipIntensity': 0,
      'precipProbability': 0,
    }, { 'time': 1541800800, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800860,
      'precipIntensity': 0.005,
      'precipIntensityError': 0.004,
      'precipProbability': 0.01,
      'precipType': 'rain',
    }, { 'time': 1541800920, 'precipIntensity': 0, 'precipProbability': 0 }, {
      'time': 1541800980,
      'precipIntensity': 0.006,
      'precipIntensityError': 0.005,
      'precipProbability': 0.01,
      'precipType': 'rain',
    }, {
      'time': 1541801040,
      'precipIntensity': 0.006,
      'precipIntensityError': 0.005,
      'precipProbability': 0.02,
      'precipType': 'rain',
    }, {
      'time': 1541801100,
      'precipIntensity': 0.006,
      'precipIntensityError': 0.005,
      'precipProbability': 0.03,
      'precipType': 'rain',
    }, {
      'time': 1541801160,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.03,
      'precipType': 'rain',
    }, {
      'time': 1541801220,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.04,
      'precipType': 'rain',
    }, {
      'time': 1541801280,
      'precipIntensity': 0.006,
      'precipIntensityError': 0.004,
      'precipProbability': 0.04,
      'precipType': 'rain',
    }, {
      'time': 1541801340,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.004,
      'precipProbability': 0.05,
      'precipType': 'rain',
    }, {
      'time': 1541801400,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.004,
      'precipProbability': 0.06,
      'precipType': 'rain',
    }, {
      'time': 1541801460,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.06,
      'precipType': 'rain',
    }, {
      'time': 1541801520,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.06,
      'precipType': 'rain',
    }, {
      'time': 1541801580,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.07,
      'precipType': 'rain',
    }, {
      'time': 1541801640,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.07,
      'precipType': 'rain',
    }, {
      'time': 1541801700,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.005,
      'precipProbability': 0.08,
      'precipType': 'rain',
    }, {
      'time': 1541801760,
      'precipIntensity': 0.007,
      'precipIntensityError': 0.007,
      'precipProbability': 0.08,
      'precipType': 'rain',
    }, {
      'time': 1541801820,
      'precipIntensity': 0.008,
      'precipIntensityError': 0.008,
      'precipProbability': 0.08,
      'precipType': 'rain',
    }, {
      'time': 1541801880,
      'precipIntensity': 0.008,
      'precipIntensityError': 0.008,
      'precipProbability': 0.08,
      'precipType': 'rain',
    }, {
      'time': 1541801940,
      'precipIntensity': 0.009,
      'precipIntensityError': 0.011,
      'precipProbability': 0.08,
      'precipType': 'rain',
    }, {
      'time': 1541802000,
      'precipIntensity': 0.009,
      'precipIntensityError': 0.009,
      'precipProbability': 0.09,
      'precipType': 'rain',
    }, {
      'time': 1541802060,
      'precipIntensity': 0.011,
      'precipIntensityError': 0.012,
      'precipProbability': 0.09,
      'precipType': 'rain',
    }, {
      'time': 1541802120,
      'precipIntensity': 0.011,
      'precipIntensityError': 0.013,
      'precipProbability': 0.09,
      'precipType': 'rain',
    }, {
      'time': 1541802180,
      'precipIntensity': 0.012,
      'precipIntensityError': 0.013,
      'precipProbability': 0.09,
      'precipType': 'rain',
    }, {
      'time': 1541802240,
      'precipIntensity': 0.012,
      'precipIntensityError': 0.014,
      'precipProbability': 0.1,
      'precipType': 'rain',
    }, {
      'time': 1541802300,
      'precipIntensity': 0.014,
      'precipIntensityError': 0.016,
      'precipProbability': 0.1,
      'precipType': 'rain',
    }, {
      'time': 1541802360,
      'precipIntensity': 0.015,
      'precipIntensityError': 0.017,
      'precipProbability': 0.1,
      'precipType': 'rain',
    }, {
      'time': 1541802420,
      'precipIntensity': 0.016,
      'precipIntensityError': 0.018,
      'precipProbability': 0.11,
      'precipType': 'rain',
    }, {
      'time': 1541802480,
      'precipIntensity': 0.018,
      'precipIntensityError': 0.019,
      'precipProbability': 0.12,
      'precipType': 'rain',
    }, {
      'time': 1541802540,
      'precipIntensity': 0.018,
      'precipIntensityError': 0.019,
      'precipProbability': 0.12,
      'precipType': 'rain',
    }, {
      'time': 1541802600,
      'precipIntensity': 0.019,
      'precipIntensityError': 0.019,
      'precipProbability': 0.14,
      'precipType': 'rain',
    }, {
      'time': 1541802660,
      'precipIntensity': 0.02,
      'precipIntensityError': 0.02,
      'precipProbability': 0.15,
      'precipType': 'rain',
    }, {
      'time': 1541802720,
      'precipIntensity': 0.021,
      'precipIntensityError': 0.021,
      'precipProbability': 0.15,
      'precipType': 'rain',
    }, {
      'time': 1541802780,
      'precipIntensity': 0.022,
      'precipIntensityError': 0.021,
      'precipProbability': 0.17,
      'precipType': 'rain',
    }, {
      'time': 1541802840,
      'precipIntensity': 0.022,
      'precipIntensityError': 0.021,
      'precipProbability': 0.18,
      'precipType': 'rain',
    }, {
      'time': 1541802900,
      'precipIntensity': 0.024,
      'precipIntensityError': 0.023,
      'precipProbability': 0.19,
      'precipType': 'rain',
    }, {
      'time': 1541802960,
      'precipIntensity': 0.023,
      'precipIntensityError': 0.022,
      'precipProbability': 0.2,
      'precipType': 'rain',
    }, {
      'time': 1541803020,
      'precipIntensity': 0.024,
      'precipIntensityError': 0.023,
      'precipProbability': 0.22,
      'precipType': 'rain',
    }, {
      'time': 1541803080,
      'precipIntensity': 0.024,
      'precipIntensityError': 0.023,
      'precipProbability': 0.24,
      'precipType': 'rain',
    } ],
  },
  'hourly': {
    'summary': 'Heavy rain starting this evening.',
    'icon': 'rain',
    'data': [ {
      'time': 1541797200,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 48.04,
      'apparentTemperature': 44.82,
      'dewPoint': 36.46,
      'humidity': 0.64,
      'pressure': 1024.08,
      'windSpeed': 7.02,
      'windGust': 10.37,
      'windBearing': 95,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 246.72,
    }, {
      'time': 1541800800,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0045,
      'precipProbability': 0.12,
      'precipType': 'rain',
      'temperature': 46.99,
      'apparentTemperature': 43.95,
      'dewPoint': 38.14,
      'humidity': 0.71,
      'pressure': 1023.59,
      'windSpeed': 6.25,
      'windGust': 11.14,
      'windBearing': 82,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 246.07,
    }, {
      'time': 1541804400,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0054,
      'precipProbability': 0.24,
      'precipType': 'rain',
      'temperature': 46.74,
      'apparentTemperature': 42.65,
      'dewPoint': 39.39,
      'humidity': 0.75,
      'pressure': 1023.43,
      'windSpeed': 8.33,
      'windGust': 15.45,
      'windBearing': 86,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 245.45,
    }, {
      'time': 1541808000,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.007,
      'precipProbability': 0.24,
      'precipType': 'rain',
      'temperature': 46.86,
      'apparentTemperature': 41.85,
      'dewPoint': 40.28,
      'humidity': 0.78,
      'pressure': 1021.79,
      'windSpeed': 10.82,
      'windGust': 21.84,
      'windBearing': 94,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 244.86,
    }, {
      'time': 1541811600,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0204,
      'precipProbability': 0.39,
      'precipType': 'rain',
      'temperature': 46.98,
      'apparentTemperature': 41.32,
      'dewPoint': 41.3,
      'humidity': 0.81,
      'pressure': 1019.61,
      'windSpeed': 13.01,
      'windGust': 27.05,
      'windBearing': 92,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 9.33,
      'ozone': 244.42,
    }, {
      'time': 1541815200,
      'summary': 'Rain',
      'icon': 'rain',
      'precipIntensity': 0.0545,
      'precipProbability': 0.67,
      'precipType': 'rain',
      'temperature': 47.49,
      'apparentTemperature': 41.51,
      'dewPoint': 42.62,
      'humidity': 0.83,
      'pressure': 1017.27,
      'windSpeed': 14.69,
      'windGust': 31.03,
      'windBearing': 92,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 8.03,
      'ozone': 244.01,
    }, {
      'time': 1541818800,
      'summary': 'Rain',
      'icon': 'rain',
      'precipIntensity': 0.1291,
      'precipProbability': 0.87,
      'precipType': 'rain',
      'temperature': 48.08,
      'apparentTemperature': 42.08,
      'dewPoint': 44.44,
      'humidity': 0.87,
      'pressure': 1015.14,
      'windSpeed': 15.4,
      'windGust': 32.86,
      'windBearing': 91,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 3.71,
      'ozone': 243.85,
    }, {
      'time': 1541822400,
      'summary': 'Rain',
      'icon': 'rain',
      'precipIntensity': 0.1641,
      'precipProbability': 0.88,
      'precipType': 'rain',
      'temperature': 48.56,
      'apparentTemperature': 42.68,
      'dewPoint': 45.56,
      'humidity': 0.89,
      'pressure': 1012.52,
      'windSpeed': 15.5,
      'windGust': 32.7,
      'windBearing': 89,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 4.61,
      'ozone': 243.92,
    }, {
      'time': 1541826000,
      'summary': 'Heavy Rain',
      'icon': 'rain',
      'precipIntensity': 0.2461,
      'precipProbability': 0.89,
      'precipType': 'rain',
      'temperature': 49.36,
      'apparentTemperature': 43.93,
      'dewPoint': 46.75,
      'humidity': 0.91,
      'pressure': 1009.56,
      'windSpeed': 14.58,
      'windGust': 30.35,
      'windBearing': 83,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 4.83,
      'ozone': 244.15,
    }, {
      'time': 1541829600,
      'summary': 'Heavy Rain',
      'icon': 'rain',
      'precipIntensity': 0.2632,
      'precipProbability': 0.91,
      'precipType': 'rain',
      'temperature': 50.3,
      'apparentTemperature': 50.3,
      'dewPoint': 47.85,
      'humidity': 0.91,
      'pressure': 1006.92,
      'windSpeed': 12.47,
      'windGust': 25.84,
      'windBearing': 77,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 4.4,
      'ozone': 244.63,
    }, {
      'time': 1541833200,
      'summary': 'Rain',
      'icon': 'rain',
      'precipIntensity': 0.2112,
      'precipProbability': 0.91,
      'precipType': 'rain',
      'temperature': 50.4,
      'apparentTemperature': 50.4,
      'dewPoint': 48.57,
      'humidity': 0.93,
      'pressure': 1005.57,
      'windSpeed': 8.99,
      'windGust': 14.95,
      'windBearing': 29,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 3.41,
      'ozone': 245.1,
    }, {
      'time': 1541836800,
      'summary': 'Light Rain',
      'icon': 'rain',
      'precipIntensity': 0.0528,
      'precipProbability': 0.85,
      'precipType': 'rain',
      'temperature': 50.43,
      'apparentTemperature': 50.43,
      'dewPoint': 48.93,
      'humidity': 0.95,
      'pressure': 1004,
      'windSpeed': 8.09,
      'windGust': 15.95,
      'windBearing': 14,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 6.25,
      'ozone': 245.84,
    }, {
      'time': 1541840400,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0124,
      'precipProbability': 0.64,
      'precipType': 'rain',
      'temperature': 50.33,
      'apparentTemperature': 50.33,
      'dewPoint': 49.06,
      'humidity': 0.95,
      'pressure': 1003.05,
      'windSpeed': 7,
      'windGust': 15.78,
      'windBearing': 2,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 6.2,
      'ozone': 247.22,
    }, {
      'time': 1541844000,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0061,
      'precipProbability': 0.46,
      'precipType': 'rain',
      'temperature': 49.79,
      'apparentTemperature': 47.21,
      'dewPoint': 48.75,
      'humidity': 0.96,
      'pressure': 1002.75,
      'windSpeed': 6.41,
      'windGust': 15.12,
      'windBearing': 337,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 6.3,
      'ozone': 249.5,
    }, {
      'time': 1541847600,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0013,
      'precipProbability': 0.28,
      'precipType': 'rain',
      'temperature': 48.91,
      'apparentTemperature': 45.8,
      'dewPoint': 48.09,
      'humidity': 0.97,
      'pressure': 1003.1,
      'windSpeed': 7.16,
      'windGust': 13.08,
      'windBearing': 240,
      'cloudCover': 0.99,
      'uvIndex': 0,
      'visibility': 7.47,
      'ozone': 252.41,
    }, {
      'time': 1541851200,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0027,
      'precipProbability': 0.26,
      'precipType': 'rain',
      'temperature': 49.62,
      'apparentTemperature': 45.83,
      'dewPoint': 47.87,
      'humidity': 0.94,
      'pressure': 1003.3,
      'windSpeed': 9.24,
      'windGust': 13.28,
      'windBearing': 258,
      'cloudCover': 1,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 256.03,
    }, {
      'time': 1541854800,
      'summary': 'Overcast',
      'icon': 'cloudy',
      'precipIntensity': 0.0017,
      'precipProbability': 0.14,
      'precipType': 'rain',
      'temperature': 50.11,
      'apparentTemperature': 50.11,
      'dewPoint': 46.75,
      'humidity': 0.88,
      'pressure': 1003.98,
      'windSpeed': 9.71,
      'windGust': 16.57,
      'windBearing': 287,
      'cloudCover': 0.94,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 260.49,
    }, {
      'time': 1541858400,
      'summary': 'Mostly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0009,
      'precipProbability': 0.08,
      'precipType': 'rain',
      'temperature': 50.66,
      'apparentTemperature': 50.66,
      'dewPoint': 45.19,
      'humidity': 0.81,
      'pressure': 1004.84,
      'windSpeed': 12.43,
      'windGust': 21.58,
      'windBearing': 243,
      'cloudCover': 0.86,
      'uvIndex': 1,
      'visibility': 10,
      'ozone': 265.58,
    }, {
      'time': 1541862000,
      'summary': 'Mostly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0006,
      'precipProbability': 0.07,
      'precipType': 'rain',
      'temperature': 50.78,
      'apparentTemperature': 50.78,
      'dewPoint': 42.82,
      'humidity': 0.74,
      'pressure': 1005.59,
      'windSpeed': 14.26,
      'windGust': 25.36,
      'windBearing': 256,
      'cloudCover': 0.8,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 270.76,
    }, {
      'time': 1541865600,
      'summary': 'Mostly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0005,
      'precipProbability': 0.07,
      'precipType': 'rain',
      'temperature': 49.57,
      'apparentTemperature': 43.95,
      'dewPoint': 39.36,
      'humidity': 0.68,
      'pressure': 1006.04,
      'windSpeed': 15.58,
      'windGust': 26.83,
      'windBearing': 192,
      'cloudCover': 0.74,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 276.05,
    }, {
      'time': 1541869200,
      'summary': 'Mostly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0006,
      'precipProbability': 0.08,
      'precipType': 'rain',
      'temperature': 47.48,
      'apparentTemperature': 40.95,
      'dewPoint': 35.48,
      'humidity': 0.63,
      'pressure': 1006.37,
      'windSpeed': 16.92,
      'windGust': 27.25,
      'windBearing': 345,
      'cloudCover': 0.66,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 281.31,
    }, {
      'time': 1541872800,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0006,
      'precipProbability': 0.08,
      'precipType': 'rain',
      'temperature': 45.46,
      'apparentTemperature': 38.14,
      'dewPoint': 32.1,
      'humidity': 0.59,
      'pressure': 1006.89,
      'windSpeed': 17.79,
      'windGust': 27.67,
      'windBearing': 270,
      'cloudCover': 0.59,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 285.81,
    }, {
      'time': 1541876400,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0.0003,
      'precipProbability': 0.07,
      'precipType': 'rain',
      'temperature': 43.64,
      'apparentTemperature': 36.11,
      'dewPoint': 29.41,
      'humidity': 0.57,
      'pressure': 1007.75,
      'windSpeed': 16.46,
      'windGust': 28.56,
      'windBearing': 294,
      'cloudCover': 0.58,
      'uvIndex': 1,
      'visibility': 10,
      'ozone': 289.09,
    }, {
      'time': 1541880000,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 42.22,
      'apparentTemperature': 34.33,
      'dewPoint': 26.94,
      'humidity': 0.54,
      'pressure': 1008.79,
      'windSpeed': 16.24,
      'windGust': 29.63,
      'windBearing': 259,
      'cloudCover': 0.58,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 291.63,
    }, {
      'time': 1541883600,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 40.97,
      'apparentTemperature': 32.57,
      'dewPoint': 24.75,
      'humidity': 0.52,
      'pressure': 1009.85,
      'windSpeed': 16.76,
      'windGust': 31,
      'windBearing': 271,
      'cloudCover': 0.54,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 294.34,
    }, {
      'time': 1541887200,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 39.62,
      'apparentTemperature': 31.48,
      'dewPoint': 22.7,
      'humidity': 0.5,
      'pressure': 1010.93,
      'windSpeed': 14.58,
      'windGust': 32.94,
      'windBearing': 326,
      'cloudCover': 0.42,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 297.86,
    }, {
      'time': 1541890800,
      'summary': 'Partly Cloudy',
      'icon': 'partly-cloudy-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 38.34,
      'apparentTemperature': 29.99,
      'dewPoint': 21.02,
      'humidity': 0.49,
      'pressure': 1012.02,
      'windSpeed': 14.15,
      'windGust': 35.19,
      'windBearing': 204,
      'cloudCover': 0.27,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 301.47,
    }, {
      'time': 1541894400,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 37.4,
      'apparentTemperature': 28.21,
      'dewPoint': 20.28,
      'humidity': 0.5,
      'pressure': 1012.94,
      'windSpeed': 15.92,
      'windGust': 36.83,
      'windBearing': 256,
      'cloudCover': 0.14,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 304.16,
    }, {
      'time': 1541898000,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 37.09,
      'apparentTemperature': 27.94,
      'dewPoint': 21,
      'humidity': 0.52,
      'pressure': 1013.5,
      'windSpeed': 15.53,
      'windGust': 37.42,
      'windBearing': 245,
      'cloudCover': 0.09,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 305.44,
    }, {
      'time': 1541901600,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 37.26,
      'apparentTemperature': 28.25,
      'dewPoint': 22.66,
      'humidity': 0.55,
      'pressure': 1013.88,
      'windSpeed': 15.21,
      'windGust': 37.29,
      'windBearing': 288,
      'cloudCover': 0.04,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 305.81,
    }, {
      'time': 1541905200,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipType': 'rain',
      'temperature': 37.38,
      'apparentTemperature': 28.51,
      'dewPoint': 23.86,
      'humidity': 0.58,
      'pressure': 1014.34,
      'windSpeed': 14.88,
      'windGust': 36.73,
      'windBearing': 263,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 305.17,
    }, {
      'time': 1541908800,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipType': 'rain',
      'temperature': 37.23,
      'apparentTemperature': 28.54,
      'dewPoint': 24.3,
      'humidity': 0.59,
      'pressure': 1014.94,
      'windSpeed': 14.25,
      'windGust': 35.76,
      'windBearing': 234,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 303.12,
    }, {
      'time': 1541912400,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipType': 'rain',
      'temperature': 36.99,
      'apparentTemperature': 28.45,
      'dewPoint': 24.33,
      'humidity': 0.6,
      'pressure': 1015.6,
      'windSpeed': 13.64,
      'windGust': 34.44,
      'windBearing': 297,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 299.94,
    }, {
      'time': 1541916000,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipType': 'rain',
      'temperature': 36.59,
      'apparentTemperature': 27.84,
      'dewPoint': 23.71,
      'humidity': 0.59,
      'pressure': 1016.39,
      'windSpeed': 13.91,
      'windGust': 33.33,
      'windBearing': 270,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 297.18,
    }, {
      'time': 1541919600,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 35.97,
      'apparentTemperature': 27.06,
      'dewPoint': 22.11,
      'humidity': 0.57,
      'pressure': 1017.35,
      'windSpeed': 13.88,
      'windGust': 32.7,
      'windBearing': 265,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 295.15,
    }, {
      'time': 1541923200,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 35.23,
      'apparentTemperature': 26.05,
      'dewPoint': 19.91,
      'humidity': 0.53,
      'pressure': 1018.45,
      'windSpeed': 14.07,
      'windGust': 32.27,
      'windBearing': 282,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 293.43,
    }, {
      'time': 1541926800,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 34.47,
      'apparentTemperature': 24.99,
      'dewPoint': 18.16,
      'humidity': 0.51,
      'pressure': 1019.48,
      'windSpeed': 14.33,
      'windGust': 31.67,
      'windBearing': 278,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 292.06,
    }, {
      'time': 1541930400,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 33.58,
      'apparentTemperature': 24.05,
      'dewPoint': 17.38,
      'humidity': 0.51,
      'pressure': 1020.45,
      'windSpeed': 13.82,
      'windGust': 30.79,
      'windBearing': 289,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 291.13,
    }, {
      'time': 1541934000,
      'summary': 'Clear',
      'icon': 'clear-night',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 32.75,
      'apparentTemperature': 23.12,
      'dewPoint': 17.03,
      'humidity': 0.52,
      'pressure': 1021.37,
      'windSpeed': 13.48,
      'windGust': 29.72,
      'windBearing': 271,
      'cloudCover': 0.01,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 290.49,
    }, {
      'time': 1541937600,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipAccumulation': 0,
      'precipType': 'snow',
      'temperature': 32.65,
      'apparentTemperature': 23.04,
      'dewPoint': 16.62,
      'humidity': 0.51,
      'pressure': 1022.15,
      'windSpeed': 13.37,
      'windGust': 28.59,
      'windBearing': 277,
      'cloudCover': 0.01,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 289.95,
    }, {
      'time': 1541941200,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0.0002,
      'precipProbability': 0.02,
      'precipAccumulation': 0,
      'precipType': 'snow',
      'temperature': 33.91,
      'apparentTemperature': 24.56,
      'dewPoint': 15.78,
      'humidity': 0.47,
      'pressure': 1022.81,
      'windSpeed': 13.56,
      'windGust': 27.26,
      'windBearing': 264,
      'cloudCover': 0.01,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 289.23,
    }, {
      'time': 1541944800,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 36.26,
      'apparentTemperature': 27.42,
      'dewPoint': 14.82,
      'humidity': 0.41,
      'pressure': 1023.33,
      'windSpeed': 13.92,
      'windGust': 25.78,
      'windBearing': 303,
      'cloudCover': 0,
      'uvIndex': 1,
      'visibility': 10,
      'ozone': 288.5,
    }, {
      'time': 1541948400,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 38.39,
      'apparentTemperature': 30.07,
      'dewPoint': 14.2,
      'humidity': 0.37,
      'pressure': 1023.61,
      'windSpeed': 14.11,
      'windGust': 24.53,
      'windBearing': 284,
      'cloudCover': 0,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 287.95,
    }, {
      'time': 1541952000,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 40.56,
      'apparentTemperature': 32.86,
      'dewPoint': 14.11,
      'humidity': 0.34,
      'pressure': 1023.46,
      'windSpeed': 14.03,
      'windGust': 23.65,
      'windBearing': 281,
      'cloudCover': 0,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 287.5,
    }, {
      'time': 1541955600,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 42.7,
      'apparentTemperature': 35.65,
      'dewPoint': 14.42,
      'humidity': 0.31,
      'pressure': 1023.1,
      'windSpeed': 13.8,
      'windGust': 23,
      'windBearing': 279,
      'cloudCover': 0,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 287.24,
    }, {
      'time': 1541959200,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 43.99,
      'apparentTemperature': 37.42,
      'dewPoint': 14.96,
      'humidity': 0.31,
      'pressure': 1022.88,
      'windSpeed': 13.39,
      'windGust': 22.43,
      'windBearing': 279,
      'cloudCover': 0,
      'uvIndex': 2,
      'visibility': 10,
      'ozone': 287.25,
    }, {
      'time': 1541962800,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 43.98,
      'apparentTemperature': 37.66,
      'dewPoint': 15.89,
      'humidity': 0.32,
      'pressure': 1022.93,
      'windSpeed': 12.56,
      'windGust': 21.89,
      'windBearing': 287,
      'cloudCover': 0,
      'uvIndex': 1,
      'visibility': 10,
      'ozone': 287.49,
    }, {
      'time': 1541966400,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 43.13,
      'apparentTemperature': 36.84,
      'dewPoint': 17.21,
      'humidity': 0.35,
      'pressure': 1023.15,
      'windSpeed': 11.82,
      'windGust': 21.4,
      'windBearing': 270,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 287.83,
    }, {
      'time': 1541970000,
      'summary': 'Clear',
      'icon': 'clear-day',
      'precipIntensity': 0,
      'precipProbability': 0,
      'temperature': 41.96,
      'apparentTemperature': 35.59,
      'dewPoint': 18.37,
      'humidity': 0.38,
      'pressure': 1023.53,
      'windSpeed': 11.23,
      'windGust': 20.94,
      'windBearing': 277,
      'cloudCover': 0,
      'uvIndex': 0,
      'visibility': 10,
      'ozone': 288.46,
    } ],
  },
  'daily': {
    'summary': 'Rain today through Tuesday, with high temperatures bottoming out at 44°F on Sunday.',
    'icon': 'rain',
    'data': [ {
      'time': 1541739600,
      'summary': 'Heavy rain starting in the evening.',
      'icon': 'rain',
      'sunriseTime': 1541762958,
      'sunsetTime': 1541799001,
      'moonPhase': 0.07,
      'precipIntensity': 0.016,
      'precipIntensityMax': 0.1641,
      'precipIntensityMaxTime': 1541822400,
      'precipProbability': 0.8,
      'precipType': 'rain',
      'temperatureHigh': 49.5,
      'temperatureHighTime': 1541782800,
      'temperatureLow': 46.98,
      'temperatureLowTime': 1541811600,
      'apparentTemperatureHigh': 46.82,
      'apparentTemperatureHighTime': 1541786400,
      'apparentTemperatureLow': 41.32,
      'apparentTemperatureLowTime': 1541811600,
      'dewPoint': 35.1,
      'humidity': 0.73,
      'pressure': 1024.81,
      'windSpeed': 4.66,
      'windGust': 32.86,
      'windGustTime': 1541818800,
      'windBearing': 84,
      'cloudCover': 0.58,
      'uvIndex': 2,
      'uvIndexTime': 1541775600,
      'visibility': 9.5,
      'ozone': 249.5,
      'temperatureMin': 34.55,
      'temperatureMinTime': 1541761200,
      'temperatureMax': 49.5,
      'temperatureMaxTime': 1541782800,
      'apparentTemperatureMin': 32.31,
      'apparentTemperatureMinTime': 1541757600,
      'apparentTemperatureMax': 46.82,
      'apparentTemperatureMaxTime': 1541786400,
    }, {
      'time': 1541826000,
      'summary': 'Mostly cloudy until evening.',
      'icon': 'partly-cloudy-day',
      'sunriseTime': 1541849434,
      'sunsetTime': 1541885338,
      'moonPhase': 0.1,
      'precipIntensity': 0.0334,
      'precipIntensityMax': 0.2632,
      'precipIntensityMaxTime': 1541829600,
      'precipProbability': 0.96,
      'precipType': 'rain',
      'temperatureHigh': 50.78,
      'temperatureHighTime': 1541862000,
      'temperatureLow': 32.65,
      'temperatureLowTime': 1541937600,
      'apparentTemperatureHigh': 50.78,
      'apparentTemperatureHighTime': 1541862000,
      'apparentTemperatureLow': 23.04,
      'apparentTemperatureLowTime': 1541937600,
      'dewPoint': 36.02,
      'humidity': 0.72,
      'pressure': 1007.95,
      'windSpeed': 7.35,
      'windGust': 37.42,
      'windGustTime': 1541898000,
      'windBearing': 273,
      'cloudCover': 0.63,
      'uvIndex': 2,
      'uvIndexTime': 1541862000,
      'visibility': 10,
      'ozone': 275.96,
      'temperatureMin': 37.09,
      'temperatureMinTime': 1541898000,
      'temperatureMax': 50.78,
      'temperatureMaxTime': 1541862000,
      'apparentTemperatureMin': 27.94,
      'apparentTemperatureMinTime': 1541898000,
      'apparentTemperatureMax': 50.78,
      'apparentTemperatureMaxTime': 1541862000,
    }, {
      'time': 1541912400,
      'summary': 'Partly cloudy overnight.',
      'icon': 'partly-cloudy-night',
      'sunriseTime': 1541935910,
      'sunsetTime': 1541971677,
      'moonPhase': 0.13,
      'precipIntensity': 0.0001,
      'precipIntensityMax': 0.0002,
      'precipIntensityMaxTime': 1541912400,
      'precipProbability': 0.09,
      'precipType': 'rain',
      'temperatureHigh': 43.99,
      'temperatureHighTime': 1541959200,
      'temperatureLow': 31.55,
      'temperatureLowTime': 1542020400,
      'apparentTemperatureHigh': 37.66,
      'apparentTemperatureHighTime': 1541962800,
      'apparentTemperatureLow': 27.05,
      'apparentTemperatureLowTime': 1542020400,
      'dewPoint': 18.63,
      'humidity': 0.47,
      'pressure': 1022.55,
      'windSpeed': 11.93,
      'windGust': 34.44,
      'windGustTime': 1541912400,
      'windBearing': 280,
      'cloudCover': 0.01,
      'uvIndex': 2,
      'uvIndexTime': 1541948400,
      'visibility': 10,
      'ozone': 290.68,
      'temperatureMin': 32.65,
      'temperatureMinTime': 1541937600,
      'temperatureMax': 43.99,
      'temperatureMaxTime': 1541959200,
      'apparentTemperatureMin': 23.04,
      'apparentTemperatureMinTime': 1541937600,
      'apparentTemperatureMax': 37.66,
      'apparentTemperatureMaxTime': 1541962800,
    }, {
      'time': 1541998800,
      'summary': 'Mostly cloudy throughout the day.',
      'icon': 'partly-cloudy-day',
      'sunriseTime': 1542022385,
      'sunsetTime': 1542058018,
      'moonPhase': 0.16,
      'precipIntensity': 0.0002,
      'precipIntensityMax': 0.0013,
      'precipIntensityMaxTime': 1542081600,
      'precipProbability': 0.12,
      'precipType': 'rain',
      'temperatureHigh': 48.77,
      'temperatureHighTime': 1542049200,
      'temperatureLow': 38.14,
      'temperatureLowTime': 1542092400,
      'apparentTemperatureHigh': 45.42,
      'apparentTemperatureHighTime': 1542049200,
      'apparentTemperatureLow': 37.67,
      'apparentTemperatureLowTime': 1542070800,
      'dewPoint': 27.38,
      'humidity': 0.62,
      'pressure': 1027.29,
      'windSpeed': 5.48,
      'windGust': 16.26,
      'windGustTime': 1542067200,
      'windBearing': 226,
      'cloudCover': 0.48,
      'uvIndex': 2,
      'uvIndexTime': 1542034800,
      'visibility': 10,
      'ozone': 300.7,
      'temperatureMin': 31.55,
      'temperatureMinTime': 1542020400,
      'temperatureMax': 48.77,
      'temperatureMaxTime': 1542049200,
      'apparentTemperatureMin': 27.05,
      'apparentTemperatureMinTime': 1542020400,
      'apparentTemperatureMax': 45.42,
      'apparentTemperatureMaxTime': 1542049200,
    }, {
      'time': 1542085200,
      'summary': 'Rain until afternoon.',
      'icon': 'rain',
      'sunriseTime': 1542108861,
      'sunsetTime': 1542144361,
      'moonPhase': 0.19,
      'precipIntensity': 0.0434,
      'precipIntensityMax': 0.1339,
      'precipIntensityMaxTime': 1542128400,
      'precipProbability': 0.96,
      'precipType': 'rain',
      'temperatureHigh': 55.52,
      'temperatureHighTime': 1542150000,
      'temperatureLow': 33.14,
      'temperatureLowTime': 1542196800,
      'apparentTemperatureHigh': 55.52,
      'apparentTemperatureHighTime': 1542150000,
      'apparentTemperatureLow': 23.48,
      'apparentTemperatureLowTime': 1542196800,
      'dewPoint': 43.43,
      'humidity': 0.86,
      'pressure': 1012.2,
      'windSpeed': 3.61,
      'windGust': 29.62,
      'windGustTime': 1542142800,
      'windBearing': 178,
      'cloudCover': 1,
      'uvIndex': 2,
      'uvIndexTime': 1542124800,
      'visibility': 5.96,
      'ozone': 290.59,
      'temperatureMin': 38.14,
      'temperatureMinTime': 1542092400,
      'temperatureMax': 55.52,
      'temperatureMaxTime': 1542150000,
      'apparentTemperatureMin': 37.98,
      'apparentTemperatureMinTime': 1542085200,
      'apparentTemperatureMax': 55.52,
      'apparentTemperatureMaxTime': 1542150000,
    }, {
      'time': 1542171600,
      'summary': 'Mostly cloudy in the morning.',
      'icon': 'partly-cloudy-day',
      'sunriseTime': 1542195336,
      'sunsetTime': 1542230706,
      'moonPhase': 0.22,
      'precipIntensity': 0.0005,
      'precipIntensityMax': 0.0041,
      'precipIntensityMaxTime': 1542175200,
      'precipProbability': 0.21,
      'precipAccumulation': 0,
      'precipType': 'snow',
      'temperatureHigh': 39.21,
      'temperatureHighTime': 1542218400,
      'temperatureLow': 29.6,
      'temperatureLowTime': 1542279600,
      'apparentTemperatureHigh': 30.95,
      'apparentTemperatureHighTime': 1542218400,
      'apparentTemperatureLow': 22.8,
      'apparentTemperatureLowTime': 1542276000,
      'dewPoint': 18.37,
      'humidity': 0.49,
      'pressure': 1013.38,
      'windSpeed': 12.43,
      'windGust': 32.36,
      'windGustTime': 1542200400,
      'windBearing': 285,
      'cloudCover': 0.43,
      'uvIndex': 2,
      'uvIndexTime': 1542207600,
      'visibility': 10,
      'ozone': 308.22,
      'temperatureMin': 31.77,
      'temperatureMinTime': 1542254400,
      'temperatureMax': 47.21,
      'temperatureMaxTime': 1542171600,
      'apparentTemperatureMin': 23.29,
      'apparentTemperatureMinTime': 1542250800,
      'apparentTemperatureMax': 42.22,
      'apparentTemperatureMaxTime': 1542171600,
    }, {
      'time': 1542258000,
      'summary': 'Clear throughout the day.',
      'icon': 'clear-day',
      'sunriseTime': 1542281811,
      'sunsetTime': 1542317052,
      'moonPhase': 0.25,
      'precipIntensity': 0.0001,
      'precipIntensityMax': 0.0003,
      'precipIntensityMaxTime': 1542304800,
      'precipProbability': 0.06,
      'precipType': 'rain',
      'temperatureHigh': 44.73,
      'temperatureHighTime': 1542308400,
      'temperatureLow': 33.91,
      'temperatureLowTime': 1542366000,
      'apparentTemperatureHigh': 40.82,
      'apparentTemperatureHighTime': 1542308400,
      'apparentTemperatureLow': 31.44,
      'apparentTemperatureLowTime': 1542340800,
      'dewPoint': 18.6,
      'humidity': 0.49,
      'pressure': 1025.39,
      'windSpeed': 5.94,
      'windGust': 15.81,
      'windGustTime': 1542258000,
      'windBearing': 254,
      'cloudCover': 0,
      'uvIndex': 2,
      'uvIndexTime': 1542294000,
      'visibility': 10,
      'ozone': 292.13,
      'temperatureMin': 29.6,
      'temperatureMinTime': 1542279600,
      'temperatureMax': 44.73,
      'temperatureMaxTime': 1542308400,
      'apparentTemperatureMin': 22.8,
      'apparentTemperatureMinTime': 1542276000,
      'apparentTemperatureMax': 40.82,
      'apparentTemperatureMaxTime': 1542308400,
    }, {
      'time': 1542344400,
      'summary': 'Mostly cloudy throughout the day.',
      'icon': 'partly-cloudy-night',
      'sunriseTime': 1542368286,
      'sunsetTime': 1542403401,
      'moonPhase': 0.28,
      'precipIntensity': 0.0001,
      'precipIntensityMax': 0.0009,
      'precipIntensityMaxTime': 1542427200,
      'precipProbability': 0.05,
      'precipType': 'rain',
      'temperatureHigh': 50.71,
      'temperatureHighTime': 1542394800,
      'temperatureLow': 37.41,
      'temperatureLowTime': 1542456000,
      'apparentTemperatureHigh': 50.71,
      'apparentTemperatureHighTime': 1542394800,
      'apparentTemperatureLow': 33.2,
      'apparentTemperatureLowTime': 1542456000,
      'dewPoint': 29.05,
      'humidity': 0.6,
      'pressure': 1021.45,
      'windSpeed': 5.41,
      'windGust': 16.96,
      'windGustTime': 1542402000,
      'windBearing': 210,
      'cloudCover': 0.48,
      'uvIndex': 2,
      'uvIndexTime': 1542380400,
      'visibility': 10,
      'ozone': 285.49,
      'temperatureMin': 33.91,
      'temperatureMinTime': 1542366000,
      'temperatureMax': 50.71,
      'temperatureMaxTime': 1542394800,
      'apparentTemperatureMin': 31.58,
      'apparentTemperatureMinTime': 1542344400,
      'apparentTemperatureMax': 50.71,
      'apparentTemperatureMaxTime': 1542394800,
    } ],
  },
  'alerts': [ {
    'title': 'Flood Watch',
    'regions': [ 'Central Middlesex County', 'Eastern Essex', 'Eastern Hampden', 'Eastern Hampshire', 'Eastern Norfolk', 'Eastern Plymouth', 'Northern Bristol', 'Northern Worcester', 'Northwest Middlesex County', 'Southeast Middlesex', 'Southern Bristol', 'Southern Plymouth', 'Southern Worcester', 'Suffolk', 'Western Essex', 'Western Hampden', 'Western Hampshire', 'Western Norfolk', 'Western Plymouth' ],
    'severity': 'watch',
    'time': 1541862000,
    'expires': 1541894400,
    'description': '...FLOOD WATCH REMAINS IN EFFECT THROUGH SATURDAY AFTERNOON... The Flood Watch continues for * Portions of northern Connecticut, Massachusetts, and Rhode Island, including the following areas, in northern Connecticut, Hartford, Tolland, and Windham. In Massachusetts, Bristol, Essex, Franklin, Hampden, Hampshire, Middlesex, Norfolk, Plymouth, Suffolk, and Worcester. In Rhode Island, Bristol, Kent, Newport, Providence, and Washington. * Through Saturday afternoon * A widespread soaking rainfall is forecast this evening and overnight. One to 2 inches of rainfall is forecast, with isolated higher totals up to 3 inches. * This rainfall will bring the potential for significant urban and poor drainage flooding. Any leaf clogged storm drains will exacerbate this potential. The rains may also bring some area rivers and streams into flood. Although Saturday is expected to be dry, some area rivers will take longer to crest, hence there is a chance that some rivers may go into flood during Saturday.\n',
    'uri': 'https://alerts.weather.gov/cap/wwacapget.php?x=MA125AC7D85DE0.FloodWatch.125AC7F3CBC0MA.BOXFFABOX.2dec49c9e137f375b41240571ab116b2',
  }, {
    'title': 'Wind Advisory',
    'regions': [ 'Central Middlesex County', 'Eastern Essex', 'Eastern Norfolk', 'Eastern Plymouth', 'Northern Bristol', 'Northern Worcester', 'Northwest Middlesex County', 'Southeast Middlesex', 'Southern Bristol', 'Southern Plymouth', 'Southern Worcester', 'Suffolk', 'Western Essex', 'Western Norfolk', 'Western Plymouth' ],
    'severity': 'advisory',
    'time': 1541862000,
    'expires': 1541894400,
    'description': '...WIND ADVISORY IN EFFECT FROM 10 AM TO 7 PM EST SATURDAY... The National Weather Service in Boston/Norton has issued a Wind Advisory, which is in effect from 10 AM to 7 PM EST Saturday. * WINDS...West 15 to 25 mph with gusts up to 50 mph. * TIMING...Developing by midday Saturday, and lasting thru the afternoon. * IMPACTS...Gusty winds will blow around unsecured objects. Tree limbs could be blown down and a few power outages may result. * LOCATION...Central and eastern Massachusetts, and Rhode Island.\n',
    'uri': 'https://alerts.weather.gov/cap/wwacapget.php?x=MA125AC7D86100.WindAdvisory.125AC7F3CBC0MA.BOXNPWBOX.20f9676e263cb7064ba560b9c288c965',
  } ],
  'flags': {
    'sources': [ 'nearest-precip', 'nwspa', 'cmc', 'gfs', 'hrrr', 'icon', 'isd', 'madis', 'nam', 'sref', 'darksky' ],
    'nearest-station': 1.792,
    'units': 'us',
  },
  'offset': -5,
}

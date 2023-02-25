import center from '@turf/center'
import distance from '@turf/distance'
import { polygon } from '@turf/helpers'
import point from 'turf-point'
import { isTransportStop } from './utils'
import { computePointsCenter } from './pointsRequest'

export const APIUrl = `http://localhost:${process.env.PORT || '3000'}/`

const maxCityDistance = 20 // was used previously, but I think the next threshold is better
const nearestPointsLimit = 4 // 4 is a symbolic number : think of a compass

const createBikeRouterQuery = (from, to) =>
	encodeURIComponent(`${from.reverse().join(',')}|${to.reverse().join(',')}`)

const computeBikeDistance = (from, to) =>
	fetch(APIUrl + `bikeRouter/${createBikeRouterQuery(from, to)}`)
		.then((res) => res.json())
		.catch((e) => console.log(e))

const isSafePath = (tags) =>
	tags.includes('highway=living_street') || tags.includes('highway=cycleway')
//TODO should we include foot paths where bikes have a separated painted lane ? I'm not sure we should. It usually creates friction between bikes and pedestrians
// maybe when it is segregated ? segregated footway and cycleway tagged on one way highway=path + bicycle=designated + foot=designated + segregated=yes
// https://wiki.openstreetmap.org/wiki/Tag:bicycle%3Ddesignated
//
// https://www.openstreetmap.org/way/190390497
// bicycle 	designated ?

const segmentGeoJSON = (geojson) => {
	const table = getMessages(geojson)
	const coordinateStringToNumber = (string) => +string / 10e5
	const getLineCoordinates = (line) =>
			line && [line[0], line[1]].map(coordinateStringToNumber),
		getLineDistance = (line) => line[3],
		getLineTags = (line) => line[9]

	return {
		type: 'FeatureCollection',
		features: table
			.slice(0, -1)
			.map((line, i) => {
				// What a mess, this is hacky
				// TODO : the "messages" table contains way less segments than the LineString. They are grouped. We should reconstruct them as Brouter Web does
				const lineBis = table[i + 1]
				if (!lineBis) return

				return {
					type: 'Feature',
					properties: {
						tags: getLineTags(lineBis),
						distance: lineBis[3],
						elevation: lineBis[2],
						weight: '3',
						opacity: '.8',
						color: isSafePath(getLineTags(lineBis)) ? 'blue' : 'red',
					},
					geometry: {
						type: 'LineString',
						coordinates: [
							getLineCoordinates(line),
							getLineCoordinates(table[i + 1]),
						],
					},
				}
			})
			.filter(Boolean),
	}
}

const getMessages = (geojson) => {
	const [_, ...table] = geojson.features[0].properties.messages

	return table
}
const computeSafePercentage = (messages) => {
	const [safeDistance, total] = messages.reduce(
		(memo, next) => {
			const safe = isSafePath(next[9]),
				distance = next[3]
			return [memo[0] + (safe ? +distance : 0), memo[1] + +distance]
		},
		[0, 0]
	)

	return Math.round((safeDistance / total) * 100)
}

export default async (ville) => {
	const points = await pointsProcess(ville)

	const rides = await Promise.all(
		points
			.map((p, i) => {
				const point1 = point([p.lon, p.lat])

				const sorted = points
					.filter(
						(p2) =>
							p != p2 && // suffices for now, it's binary
							isTransportStop(p) === isTransportStop(p2)
					)
					.sort(
						(pa, pb) =>
							distance(point([pa.lon, pa.lat]), point1) -
							distance(point([pb.lon, pb.lat]), point1)
					)
				const firstX = sorted.slice(0, nearestPointsLimit)

				return firstX.map((p2, j) =>
					new Promise((resolve) => setTimeout(resolve, 10 * (i + j))).then(() =>
						computeBikeDistance([p.lat, p.lon], [p2.lat, p2.lon]).then(
							(res) => res
						)
					)
				)
			})
			.flat()
	)
	const filteredRides = rides.filter(
		(ride) =>
			// Exclude itineraries that include a ferry route.
			// TODO maybe we should just exclude the subrides that are ferry ? Doesn't matter much on the final result
			!getMessages(ride).some((ride) => ride[9].includes('route=ferry'))
	)

	const score = computeSafePercentage(
		filteredRides.map((ride) => getMessages(ride)).flat()
	)
	const segments = filteredRides
		.map((ride) => segmentGeoJSON(ride))
		.map((r) => r.features)
		.flat()

	const pointsCenter = computePointsCenter(points)

	return { pointsCenter, points, segments, score }
}

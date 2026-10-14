# US West Tracks

Every ride and hike recorded in Gaia GPS, each in 3D on satellite imagery, with an elevation profile and a "Play Ride" fly-through.

Modeled on [Beckwourth Peak](https://beckwourth.bkxc.chatgpt.site/) and the open-source [tahoe-trails](https://github.com/kneath/tahoe-trails).

## Adding tracks

1. In Gaia GPS on the web, open **Saved**, select the tracks (or a folder) and click **Export → GPX**.
2. Run `npm run import -- ~/Downloads/export.gpx`. It writes one GPX per ride or hike into `tracks/`.
   A recording left running for a whole trip is split at long pauses, and stretches driven at highway
   speed are dropped, so the drives (and your home) never end up in this public repo.
   For a multi-day trip shown as one track, keep everything between two places instead:
   `npm run import -- export.gpx --from 39.5596,-120.8266 --to 39.3280,-120.1833 --name "Downieville to Truckee"`
3. Optionally give a track a nicer title, location, summary or link in `tracks/meta.json`, keyed by the track's slug (shown in the build log):

   ```json
   {
     "beckwourth-peak": {
       "title": "Beckwourth Peak",
       "location": "Portola, California",
       "summary": "A climb around the peak and a long descent through fall color.",
       "link": "https://www.gaiagps.com/...",
       "hidden": false
     }
   }
   ```

4. Push to `main`. GitHub Actions builds the site and publishes it to GitHub Pages.

## Time

Every point keeps its recorded timestamp, from the GPX in `tracks/` through to the page, so photos can be matched to where they were taken. The elevation readout shows the time of day (Pacific) under the cursor, and Play Ride follows the recorded clock with pauses over two minutes squeezed out.

Stops of 5 minutes or more are detected from the timestamps. Camps (stops spanning a night) are labeled on the map and flagged on the elevation profile; Play Ride waits at each one while the clock runs through it, with a **Skip to departure** button.

## Local development

```sh
npm install
npm run data   # GPX -> public/data (downloads terrain tiles into .cache/)
npm run dev
```

`npm run build` runs the data step, type-checks and writes the static site to `dist/`.

## How it works

- `scripts/build-data.mjs` parses each GPX track, computes distance, climbing (with a noise threshold) and moving time, and downloads [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) around it into a ~320×320 Int16 heightmap.
- `src/terrain.ts` turns the heightmap into a diorama block with Three.js; `src/satellite.ts` stitches Esri World Imagery tiles into a texture draped over it.
- `src/track.ts` drapes the track on the terrain, links the marker to the elevation profile, and runs the chase-camera fly-through.
- Place names come from OpenStreetMap Nominatim when the build has network access.

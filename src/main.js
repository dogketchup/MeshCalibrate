import './style.css'
import heroImg from './assets/hero.png'
import javascriptLogo from './assets/javascript.svg'
import viteLogo from './assets/vite.svg'

import { setupCounter } from './counter.js'


document.querySelector('#app').innerHTML = `
<head>

  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ~~~~~
  <script type="importmap">
  {
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
  }
}
</script>
</head>
<section id="top">
  <div >
      </div>
    Welcome to Mesh Calibrate
      <div>
  </div>
  <button id="counter" type="button" class="counter"></button>
  <div>

<div class="vertical-stack">
  <div>
    <label for="build_plate_x">Adjust build plate x in cm></label>
    <input type="range" value="10" min="1" max="35" class="slider" id="build_plate_x" ></input>
  </div>
  <div>
   <label for="build_plate_y">Adjust build plate y in cm</label>
   <input type="range" value="10" min="1" max="35" class="slider" id="build_plate_y"></input>
  </div>
</div>

  <label for="generate_tag_code">ArUco marker id</label>
  <input type="range" value="40" min="0" max="100" class="slider" id="generate_tag_code"</input>
  <img id="aruco-marker" alt="ArUco marker" width="250" height="250" />
  <style>
    .vertical-stack {
      display: flex;
      flex-direction: column; /* Stacks items vertically */
      gap: 10px;              /* Adds space between items */
    }
    #aruco-marker {
      align-self: flex-start;
      margin-top: 10px;
    }
  </style>
    <canvas id="plane_1_texture"></canvas>

</div>

</section>
<section id = "center">
</section>
`

// threejsscene.js reads #build_plate_x from the DOM, so it must be imported
// only after the markup above has been inserted.
await import ('./threejsscene.js')
await import ('./arCuoTag.js')



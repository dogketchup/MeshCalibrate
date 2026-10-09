import { arucoToSVGString } from 'aruco-marker';

const svgImage = arucoToSVGString(155, '500px'); // the size is optional
document.getElementById('marker').innerHTML = svgImage;

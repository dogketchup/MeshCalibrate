#Overview
In class I was wondering if I could make a web app that exported calibration arUco tags I can 3d print. This project is a mix of handwritten code and qwen3.8 4bit quantized running locally on a GPU.
While definitely not perfect with a 20k token context, it was impressive how much it could do for a non frontier model. Surprisingly it implemented a psuedo-code algorithm from gemeni better than gemeni wrote javascript for it.
However for the physics space maximization problem tuning the hyper parameters by hand ended up being the best method.
I found it was exceptional at debugging, and worked best when it referenced my handwritten code serving as a scaffold. 

This mesh rendered allows you to make one calibration plane with 4+ arUco tags.

#running the project
root directory run
```
npm run dev
```
open up vite's default port and change the starting tag id and and tag count.
you can also adjust how big the plate must be.
when satisfied with the bottom rendering, export to .glb and import directly into bambu studio or orca. use a multi-color printer with black and white as options.

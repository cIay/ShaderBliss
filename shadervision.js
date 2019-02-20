let fragShaders = null;
let flags = {
  execNewShaders: false,
  resetFBO: false,
  resetAudio: false,
  takeScreenshot: false
};
let state = {
  audioSource: null, // 'video', 'mic', 'none'
  mediaType: null // 'video', 'image'
}

if (document.readyState == 'loading') {
  document.addEventListener('readystatechange', main);
}
else {
  main();
}

/*
function attachPlayListeners(videos, elements) {
  for (let i = 0; i < videos.length; i++) {
    videos[i].addEventListener('play', function() {
      state.mediatype = 'video';
      elements.video = videos[i];
      elements.media = elements.video;
    });
  }
}
*/

function main() {

  function getLargestElement(elementList) {
    if (elementList[0]) {
      var largestElement = elementList[0];
      let dimensions = largestElement.width * largestElement.height;
      for (let i = 1; i < elementList.length; i++) {
        let curDimensions = elementList[i].width * elementList[i].height;
        if (curDimensions > dimensions) {
          largestElement = elementList[i];
          dimensions = curDimensions;
        }
      }
      return largestElement;
    }
    else {
      return null;
    }
  }

  const elements = {
    video: getLargestElement(document.getElementsByTagName('video')),
    image: getLargestElement(document.getElementsByTagName('img')),
    media: null,
    canvas: null
  };

  if (elements.video) {
    state.mediaType = 'video';
    elements.media = elements.video;
    //attachPlayListeners(document.getElementsByTagName('video'), elements);
  }
  else if (elements.image) {
    state.mediaType = 'image';
    elements.media = elements.image;
  }

  initCanvas(elements);

  const gl = elements.canvas.getContext('webgl2', {
    powerPreference: "high-performance",
    preserveDrawingBuffer: false
  });
  if (!gl) {
    alert('ShaderVision: Unable to initialize WebGL. Your browser or machine may not support it.'); 
    return;
  }

  let recorder = new Recorder(elements.canvas);
  let audio = new AudioProcessor();


  const observers = {
    resizeObserver: null,
    attributeObserver: null,
    childObserver: null
  }
  initObservers(observers, elements);

  document.addEventListener('keydown', (e) => {
    if (e.altKey) {
      if (e.key == 'r') {
        if (fragShaders) {
          recorder.toggleRecording();
        }
      }
      else if (e.key == 's') {
        if (fragShaders) {
          flags.takeScreenshot = true;
        }
      }
      else if (e.key == 'a') {
        chrome.runtime.sendMessage({requestShaders: true});
      }
    }
  });

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.target != 'canvas') {
      return;
    }

    if (request.ping) {
      sendResponse({pong: true});
    }
    else if (request.shaders && request.settings) {
      applySettings(request.settings, audio, recorder);
      initMediaStream(elements, audio, recorder);

      if (fragShaders === null) {
        showCanvas(elements);
        hideMedia(elements);
        fragShaders = request.shaders.contents;
        execShaders(gl, request.settings, request.textures, elements, audio, recorder);
      }
      else {
        flags.execNewShaders = true;
        // wait for previous render loop to return
        (function waitThenExecute() {
          if (flags.execNewShaders) {
            setTimeout(waitThenExecute, 50);
          }
          else {
            fragShaders = request.shaders.contents;
            execShaders(gl, request.settings, request.textures, elements, audio, recorder);
          }
        })();
      }
    }
  });
}


function execShaders(gl, settings, textures, elements, audio, recorder) {
  console.log("ShaderVision: Running...");

  function endProgram() {
    fragShaders = null;
    showMedia(elements);
    hideCanvas(elements);
    console.log("ShaderVision: Dead");
  }
  const programInfo = initPrograms(gl, textures.length);
  if (programInfo === null) {
    endProgram();
    return;
  }

  let mouseCoords = {x: 0.0, y: 0.0};
  initMouseListener(elements, mouseCoords);

  const buffer = initBuffer(gl);
  const texture = initTexture(gl);
  const freqTexture = initTexture(gl); 
  const timeTexture = initTexture(gl);
  let pingPongData = initFboPingPong(gl, programInfo);

  initImageTextures(gl, textures);
  
  flags.resetFBO = false;

  const elapsed = performance.now();
  let prevTime = 0.0;
  let frameCount = 0;

  // Draw the scene repeatedly
  function render(time) {
    time -= elapsed;
    time *= 0.001;  // convert to seconds
    const deltaTime = time - prevTime;
    prevTime = time;

    if (flags.execNewShaders) {
      clearScene(gl);
      flags.execNewShaders = false;
      return;
    }

    if (flags.resetFBO) {
      //console.log("resetFBO");
      pingPongData = initFboPingPong(gl, programInfo);
      flags.resetFBO = false;
    }

    if (flags.resetAudio) {
      //console.log("resetAudio");
      initMediaStream(elements, audio, recorder);
      flags.resetAudio = false;
    }

    updateAudio(gl, freqTexture, timeTexture, audio);
    const low = audio.sumSubBand(0, 300);
    const mid = audio.sumSubBand(300, 4000);
    const high = audio.sumSubBand(4000, (audio.context.sampleRate / 2));
    const total = audio.sumSubBand(0, (audio.context.sampleRate / 2));
    audio.pushAllEnergy(low, mid, high, total);

    if (!updateTexture(gl, texture, elements.media)) {
      if (elements.media.currentSrc) {
        chrome.runtime.sendMessage({tabUrl: elements.media.currentSrc});
      }
      endProgram();
      return;
    }

    const uniforms = {
      mouse: mouseCoords,
      bass: low,
      avgBass: audio.averageEnergyHistory(audio.lowHistory),
      mid: mid,
      avgMid: audio.averageEnergyHistory(audio.midHistory),
      treb: high,
      avgTreb: audio.averageEnergyHistory(audio.highHistory),
      energy: total,
      avgEnergy: audio.averageEnergyHistory(audio.totalHistory),
      time: time,
      deltaTime: deltaTime,
      frameCount: frameCount
    };
    drawScene(gl, programInfo, buffer, pingPongData, uniforms, textures.length);

    if (flags.takeScreenshot) {
      recorder.takeScreenshot();
      flags.takeScreenshot = false;
    }
    
    frameCount++;

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

function initBuffer(gl) {
  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const positions = [-1.0, -1.0, 
                      1.0, -1.0, 
                      -1.0, 1.0, 
                      1.0, -1.0, 
                      1.0, 1.0, 
                      -1.0, 1.0];
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW );
  return buffer;
}


function initTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  return texture;
}

function initImageTextures(gl, textures) {
  if (!textures) {
    return;
  }
  for (let i = 0; i < textures.length; i++) {
    const img = new Image();
    img.src = textures[i];
    img.addEventListener('load', function() {
      gl.activeTexture(gl.TEXTURE3+i);
      gl.bindTexture(gl.TEXTURE_2D, initTexture(gl));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.activeTexture(gl.TEXTURE0);
    });
  }
}

function initFboPingPong(gl, programInfo) {
  if (programInfo.length == 1) {
    return null;
  }

  const pingPongData = {
    textures: [],
    framebuffers: []
  };
  for (let i = 0; i < 2; i++) {
    const texture = initTexture(gl);
    pingPongData.textures.push(texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
                  gl.canvas.width, gl.canvas.height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    pingPongData.framebuffers.push(fbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, 
                            gl.TEXTURE_2D, texture, 0);
  }

  return pingPongData;
}


// Copy the video/image texture
function updateTexture(gl, texture, media) {
  const level = 0;
  const internalFormat = gl.RGBA;
  const srcFormat = gl.RGBA;
  const srcType = gl.UNSIGNED_BYTE;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (media.nodeName == 'VIDEO' && media.readyState < 3) {
    return true;
  }
  try {
    gl.texImage2D(gl.TEXTURE_2D, level, internalFormat,
                  srcFormat, srcType, media);
  }
  catch (err) {
    console.log(err);
    return false;
  }
  return true;
}

function updateAudio(gl, freqTexture, timeTexture, audio) {
  if (state.audioSource == 'video' || state.audioSource == 'mic') {
    audio.analyser.getByteFrequencyData(audio.frequencyData);
    audio.analyser.getByteTimeDomainData(audio.timeDomainData);
    audio.instantAnalyser.getByteFrequencyData(audio.instantFrequencyData);
  }
  else {
    audio.frequencyData.fill(0);
    audio.timeDomainData.fill(0);
    audio.instantFrequencyData.fill(0);
  }

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, freqTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, audio.frequencyData.length, 1, 0,
                gl.LUMINANCE, gl.UNSIGNED_BYTE, audio.frequencyData);
  
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, timeTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, audio.timeDomainData.length, 1, 0,
                gl.LUMINANCE, gl.UNSIGNED_BYTE, audio.timeDomainData);

  gl.activeTexture(gl.TEXTURE0);
}

function clearScene(gl) {
  // Clear to black, fully opaque
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function drawScene(gl, programInfo, buffer, pingPongData, uniforms, numTextures) {

  function bindAndDraw(programIndex, fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    gl.uniform1i(programInfo[programIndex].uniformLocations.frame, 0);
    for (let i = 0; i < numTextures; i++) {
      gl.uniform1i(programInfo[programIndex].uniformLocations[`tex${i+1}`], 3+i);
    }
    //gl.uniform1i(programInfo[programIndex].uniformLocations.prevDraw, (uniforms.frameCount > 0) ? 3 : 0);
    gl.uniform2f(programInfo[programIndex].uniformLocations.resolution, 
                 gl.canvas.width, gl.canvas.height);
    gl.uniform2f(programInfo[programIndex].uniformLocations.mouse, 
                 uniforms.mouse.x, uniforms.mouse.y);
    gl.uniform1i(programInfo[programIndex].uniformLocations.freqData, 1);
    gl.uniform1i(programInfo[programIndex].uniformLocations.timeData, 2);
    gl.uniform1f(programInfo[programIndex].uniformLocations.bass, uniforms.bass);
    gl.uniform1f(programInfo[programIndex].uniformLocations.avgBass, uniforms.avgBass);
    gl.uniform1f(programInfo[programIndex].uniformLocations.mid, uniforms.mid);
    gl.uniform1f(programInfo[programIndex].uniformLocations.avgMid, uniforms.avgMid);
    gl.uniform1f(programInfo[programIndex].uniformLocations.treb, uniforms.treb);
    gl.uniform1f(programInfo[programIndex].uniformLocations.avgTreb, uniforms.avgTreb);
    gl.uniform1f(programInfo[programIndex].uniformLocations.energy, uniforms.energy);
    gl.uniform1f(programInfo[programIndex].uniformLocations.avgEnergy, uniforms.avgEnergy);
    gl.uniform1f(programInfo[programIndex].uniformLocations.time, uniforms.time);
    gl.uniform1f(programInfo[programIndex].uniformLocations.deltaTime, uniforms.deltaTime);

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Apply each shader by fbo ping-ponging
  for (var i = 0; i < programInfo.length; i++) {
    { 
      const numComponents = 2;
      const type = gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(programInfo[i].attribLocations.vertexPosition,
                             numComponents, type, normalize, stride, offset);
      gl.enableVertexAttribArray(programInfo[i].attribLocations.vertexPosition);
    }

    // Tell WebGL to use our program when drawing
    gl.useProgram(programInfo[i].program);
    // Tell WebGL we want to affect texture unit 0
    gl.activeTexture(gl.TEXTURE0);

    if (i != programInfo.length-1) {
      bindAndDraw(i, pingPongData.framebuffers[i%2]);
      gl.bindTexture(gl.TEXTURE_2D, pingPongData.textures[i%2]);
    }
  }

  bindAndDraw(programInfo.length-1, null);

  /*
  (function saveDraw() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, pingPongData.framebuffers[uniforms.frameCount%2+2]);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, pingPongData.textures[uniforms.frameCount%2+2]);
    gl.activeTexture(gl.TEXTURE0);
  })();
  */
}

function initPrograms(gl, numTextures) {

  if (fragShaders.length == 0) {
    return null;
  }

  let parser = new Parser();
  // Vertex shader program
  const vsSource = parser.getSource(fragShaders[0]);

  const shaderPrograms = [];
  const programInfo = [];
  for (let i = 0; i < fragShaders.length; i++) {
    shaderPrograms.push(initShaderProgram(gl, vsSource, fragShaders[i]));
    if (shaderPrograms[i] == null) {
      return null;
    }
    programInfo.push({
      program: shaderPrograms[i],
      attribLocations: {
        vertexPosition: gl.getAttribLocation(shaderPrograms[i], 'aVertexPosition')
      },
      uniformLocations: {
        frame: gl.getUniformLocation(shaderPrograms[i], 'frame'),
        //prevDraw: gl.getUniformLocation(shaderPrograms[i], 'prevDraw'),
        resolution: gl.getUniformLocation(shaderPrograms[i], 'resolution'),
        mouse: gl.getUniformLocation(shaderPrograms[i], 'mouse'),
        freqData: gl.getUniformLocation(shaderPrograms[i], 'freqData'),
        timeData: gl.getUniformLocation(shaderPrograms[i], 'timeData'),
        bass: gl.getUniformLocation(shaderPrograms[i], 'bass'),
        avgBass: gl.getUniformLocation(shaderPrograms[i], 'avgBass'),
        mid: gl.getUniformLocation(shaderPrograms[i], 'mid'),
        avgMid: gl.getUniformLocation(shaderPrograms[i], 'avgMid'),
        treb: gl.getUniformLocation(shaderPrograms[i], 'treb'),
        avgTreb: gl.getUniformLocation(shaderPrograms[i], 'avgTreb'),
        energy: gl.getUniformLocation(shaderPrograms[i], 'energy'),
        avgEnergy: gl.getUniformLocation(shaderPrograms[i], 'avgEnergy'),
        time: gl.getUniformLocation(shaderPrograms[i], 'time'),
        deltaTime: gl.getUniformLocation(shaderPrograms[i], 'deltaTime')
      }
    });
    for (let j = 0; j < numTextures; j++) {
      programInfo[i].uniformLocations[`tex${j+1}`] = gl.getUniformLocation(shaderPrograms[i], `tex${j+1}`);
    }
  }

  return programInfo;
}

// Initialize a shader program, so WebGL knows how to draw our data
function initShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (vertexShader == null || fragmentShader == null) {
    return null;
  }

  const shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    alert('ShaderVision: Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
    return null;
  }

  return shaderProgram;
}

// Creates a shader of the given type, uploads the source and compiles it
function loadShader(gl, type, source) {
  const shader = gl.createShader(type);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    alert('ShaderVision: An error occurred compiling the shader: ' + gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}






/* Canvas injection & formatting */

function setDimensions(elements) {
  if (state.mediaType == 'video') {
    var mediaWidth = elements.media.videoWidth;
    var mediaHeight = elements.media.videoHeight;
  }
  else if (state.mediaType == 'image') {
    var mediaWidth = elements.media.width;
    var mediaHeight = elements.media.height;  
  }

  if (elements.canvas.width != mediaWidth || elements.canvas.height != mediaHeight) {
    flags.resetFBO = true;
  }
  
  elements.canvas.width = mediaWidth;
  elements.canvas.height = mediaHeight;

  elements.canvas.style.width = elements.media.clientWidth + "px";
  elements.canvas.style.height = elements.media.clientHeight + "px";
}

function showCanvas(elements) {
  if (elements.canvas) {
    elements.canvas.style.visibility = '';
  }
}

function hideCanvas(elements) {
  if (elements.canvas) {
    elements.canvas.style.visibility = 'hidden';
  }
}

function showMedia(elements) {
  if (elements.media) {
    elements.media.style.visibility = '';
  }
}

function hideMedia(elements) {
  if (state.mediaType == 'video') {
    if (!elements.video.controls) {
      elements.media.style.visibility = 'hidden';
    }
  }
  else if (state.mediaType == 'image') {
    elements.media.style.visibility = 'hidden';
  }
}

function reStyle(elements) {
  if (state.mediaType == 'video') {
    if (elements.video.controls) {
      elements.canvas.style.position = 'absolute';
      elements.video.style.position = 'static';
      elements.video.parentNode.style.display = 'flex';
      elements.video.parentNode.style.alignItems = 'center';
      elements.video.parentNode.style.justifyContent = 'center';
      elements.video.parentNode.style.height = '100vh';
      elements.video.parentNode.style.margin = '0';
    }
  }
  else {
    elements.canvas.style.position = 'absolute';
  }
}

function initCanvas(elements) {
  if (elements.canvas !== null) {
    elements.canvas.parentNode.removeChild(elements.canvas);
  }
  elements.canvas = document.createElement('canvas');
  elements.canvas.id = 'shadervision-canvas';
  elements.canvas.style.margin = '0px auto';
  elements.canvas.style.display = 'block';
  elements.canvas.style.visibility = 'hidden';
  elements.canvas.style.objectFit = 'contain';
  setDimensions(elements);
  reStyle(elements);
  elements.media.insertAdjacentElement('beforebegin', elements.canvas);
}



function initResizeObserver(resizeObserver, elements) {

  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  let handleResize = function(entry) {
    setDimensions(elements);
  };

  resizeObserver = new ResizeObserver(function(entries) {
    if (fragShaders) {
      entries.forEach(handleResize);
    }
  });
  resizeObserver.observe(elements.media);

  return resizeObserver;
}


function initAttributeObserver(attributeObserver, elements) {

  if (attributeObserver) {
    attributeObserver.disconnect();
  }

  let handleMutation = function(mutation) {
    // video style change.. make sure it is still hidden
    if (mutation.type == 'attributes' && mutation.attributeName == 'style') {
      attributeObserver.disconnect();
      hideMedia(elements);
      attributeObserver.observe(elements.video, {attributes: true});
    }
    // video source change, so ensure correct dimensions
    if (mutation.type == 'attributes' && mutation.attributeName == 'src') {
      if (elements.video.readyState == 0) {
        attributeObserver.disconnect();
        elements.video.addEventListener('loadedmetadata', (e) => {
          setDimensions(elements);
          e.target.removeEventListener(e.type, arguments.callee);
        });
        attributeObserver.observe(elements.video, {attributes: true});
      }
      else {
        setDimensions(elements);
      }
    }
  }

  attributeObserver = new MutationObserver(function(mutationsList) {
    if (fragShaders) {
      mutationsList.forEach(handleMutation);
    }
  });
  attributeObserver.observe(elements.video, {attributes: true});

  return attributeObserver;
}


function initChildObserver(childObserver, elements) {

  if (childObserver) {
    childObserver.disconnect();
  }

  let handleMutation = function(mutation) {
    if (mutation.type == 'childList' && mutation.addedNodes.length > 0) {
      for (let node of mutation.addedNodes) {
        // switch to the new video
        if (node.nodeName == 'VIDEO') {
          elements.video = node;
          flags.resetAudio = true;
          resizeObserver.disconnect();
          resizeObserver.observe(elements.video);
          attributeObserver.disconnect();
          attributeObserver.observe(elements.video, {attributes: true});
          break;
        }
      }
    }
  }

  childObserver = new MutationObserver(function(mutationsList) {
    if (fragShaders) {
      mutationsList.forEach(handleMutation);
    }
  });
  childObserver.observe(elements.video.parentElement, {childList: true});

  return childObserver;
}

function initObservers(observers, elements) {
  observers.resizeObserver = initResizeObserver(observers.resizeObserver, elements);
  if (state.mediaType == 'video') {
    observers.attributeObserver = initAttributeObserver(observers.attributeObserver, elements);
    observers.childObserver = initChildObserver(observers.childObserver, elements);
  }
}



function Parser() {
// Public:
  this.getSource = (shader) => {
    if (getVersion(shader) == "#version 300 es") {
      return `#version 300 es
        in vec4 aVertexPosition;
        void main(void) {
          gl_Position = aVertexPosition;
        }
      `;
    }
    else {
      return `
        attribute vec4 aVertexPosition;
        void main(void) {
          gl_Position = aVertexPosition;
        }
      `;
    }
  }

// Private:
  let getVersion = (shader) => {
    return shader.split(/\r?\n/)[0];
  }; 
}


function Recorder(canvas) {
// Public:
  this.recordingFlag = false;
  this.options = {
    videoBitsPerSecond: null,
    audioBitsPerSecond: null,
    mimeType: 'video/webm; codecs="vp8"' // alternative: vp9,opus
  };

  this.setOptions = (videoBitrate, audioBitrate) => {
    this.options.videoBitsPerSecond = videoBitrate;
    this.options.audioBitsPerSecond = audioBitrate;
  };

  this.setStream = (audioStream) => {
    this.stream = canvas.captureStream(60); // max fps
    if (audioStream) {
      let track = audioStream.getAudioTracks()[0];
      this.stream.addTrack(track);
    }
  };

  this.toggleRecording = () => {
    if (!this.recordingFlag) {
      if (this.stream) {
        this.recordingFlag = true;
        startRecording();
      }
    }
    else {
      this.recordingFlag = false;
      stopRecording();
    }
  };

  this.takeScreenshot = () => {
    canvas.toBlob(function(png) {
      chrome.runtime.sendMessage({tabUrl: URL.createObjectURL(png)});
    });
  };

// Private:
  let mediaRecorder;

  let recIcon = document.createElement('img');
  recIcon.id = 'shadervision-rec';
  recIcon.src = chrome.runtime.getURL("images/rec64.png");
  recIcon.style.position = 'absolute';
  recIcon.style.top = '0%';
  recIcon.style.left = '0%';
  recIcon.style.transform = 'scale(0.7)';
  recIcon.style.padding = '4px';


  let startRecording = () => {
    mediaRecorder = new MediaRecorder(this.stream, this.options);
    let recordedBlobs = [];

    mediaRecorder.onstop = () => {
      const buf = new Blob(recordedBlobs, {type: this.options.mimeType});
      const recSource = URL.createObjectURL(buf);
      chrome.runtime.sendMessage({tabUrl: recSource});
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedBlobs.push(event.data);
      }
    }

    const timeslice = 3000; // ms
    mediaRecorder.start(timeslice);

    console.log("ShaderVision: Started recording");
    canvas.insertAdjacentElement('afterend', recIcon);
  };

  let stopRecording = () => {
    mediaRecorder.stop();
    console.log("ShaderVision: Stopped recording");
    canvas.parentElement.removeChild(recIcon);
  };
}





function AudioProcessor() {
// Public:
  this.context = new AudioContext();
  this.analyser = this.context.createAnalyser();
  this.instantAnalyser = this.context.createAnalyser();
  /*
  this.filter = this.context.createBiquadFilter();
  this.filter.type = 'allpass';
  //this.filter.frequency.value = 1000; //10 hz to Nyquist, default 350 hz
  //this.filter.gain.value = 40; //-40 dB to 40 dB, default 0 dB
  //this.filter.Q.value = 500; //0.0001 to 1000, default 1
  */
  this.streamSource = null;
  this.elementSource = null;

  this.setBuffers = (fftSize, smoothingFactor) => {
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = smoothingFactor;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeDomainData = new Uint8Array(this.analyser.fftSize);

    this.instantAnalyser.fftSize = fftSize;
    this.instantAnalyser.smoothingTimeConstant = 0;
    this.instantFrequencyData = new Uint8Array(this.instantAnalyser.frequencyBinCount);

    this.lowHistory = [], this.midHistory = [], this.highHistory = [], this.totalHistory = [];
    this.historyLen = Math.ceil(this.context.sampleRate / this.instantAnalyser.fftSize);
  }

  this.connectSource = (mediaSource) => {
    this.analyser.disconnect();
    if (this.source) {
      this.source.disconnect();
    }
    this.source = mediaSource;
    //this.source.connect(this.filter);

    if (mediaSource.mediaStream) {
      if (this.elementSource) {
        this.elementSource.connect(this.context.destination);
      }
      this.source.connect(this.analyser);
      this.source.connect(this.instantAnalyser);
      this.stream = this.source.mediaStream;
    }
    else if (mediaSource.mediaElement) {
      this.source.connect(this.analyser);
      this.source.connect(this.instantAnalyser);
      //this.filter.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      let dest = this.context.createMediaStreamDestination();
      this.source.connect(dest);
      this.stream = dest.stream;
    }
  };

  this.pushAllEnergy = (low, mid, high, total) => {
    function pushEnergy(history, energy) {
      if (history.length == this.historyLen) {
        history.shift();
      }
      history.push(energy);
    }
    pushEnergy(this.lowHistory, low);
    pushEnergy(this.midHistory, mid);
    pushEnergy(this.highHistory, high);
    pushEnergy(this.totalHistory, total);
  };

  this.averageEnergyHistory = (history) => {
    return history.reduce(function(acc, val) {
      return acc + val;
    }, 0) / history.length;
  };

  this.sumSubBand = (minFreq, maxFreq) => {
    if (minFreq > maxFreq) {
      let temp = minFreq;
      minFreq = maxFreq;
      maxFreq = temp;
    }

    let acc = 0; //, count = 0;
    for (let i = getFreqIndex(minFreq); i <= getFreqIndex(maxFreq); i++) {
      let mag = reverseDBConversion(this.frequencyData[i]);
      acc += mag*mag;
      //count += 1;
    }
    return acc; /// count;
  };

//Private:
  let getFreqIndex = (freq) => {
    return Math.floor(
      (freq / (this.context.sampleRate / 2)) * (this.frequencyData.length - 1)
    );
  };
  
  let reverseDBConversion = (dB) => {
    let range = this.analyser.maxDecibels - this.analyser.minDecibels;
    return Math.pow(10, (dB/255*range + this.analyser.minDecibels) / 20);
  };
}


function initMediaStream(elements, audio, recorder) {

  if (state.audioSource == 'mic') {
    let constraints = {
      channelCount : {ideal: 2},
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false
    };

    //console.log(navigator.mediaDevices.getSupportedConstraints());
    navigator.mediaDevices.getUserMedia({audio: constraints}).then((stream) => {
      try {
        audio.streamSource = audio.context.createMediaStreamSource(stream);
      } catch {}
      audio.connectSource(audio.streamSource);
      recorder.setStream(audio.stream);
    });
  }
  else if (state.audioSource == 'video' && state.mediaType == 'video') {
    try {
      audio.elementSource = audio.context.createMediaElementSource(elements.video);
    } catch {}
    audio.connectSource(audio.elementSource);
    recorder.setStream(audio.stream);
  }
  else {
    recorder.setStream();
  }
}

function applySettings(settings, audio, recorder) {
  state.audioSource = settings.audioSource;
  recorder.setOptions(settings.videoBitrate, settings.audioBitrate);
  audio.setBuffers(settings.fftSize, settings.smoothingFactor);
}


function initMouseListener(elements, mouseCoords) {

  function setMouseCoords(elements, mouseCoords, clientX, clientY) {
    let rect = elements.canvas.getBoundingClientRect();
    mouseCoords.x = (clientX - rect.left) / elements.canvas.clientWidth;
    mouseCoords.y = (elements.canvas.clientHeight - (clientY - rect.top)) / elements.canvas.clientHeight;
  }

  elements.media.addEventListener('mousemove', function(e) {
    setMouseCoords(elements, mouseCoords, e.clientX, e.clientY);
  });

  elements.canvas.addEventListener('mousemove', function(e) {
    setMouseCoords(elements, mouseCoords, e.clientX, e.clientY);
  });
}
var video = document.getElementById('video');

function playM3u8(url) {
    if(url == undefined){
        window.location.href = '../';
    }
    
    if (Hls.isSupported()) {
        video.volume = 0.3;
        var hls = new Hls();
        var m3u8Url = decodeURIComponent(url)
        hls.loadSource(m3u8Url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            video.play();
        });
    }
    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('canplay', function () {
            video.play();
        });
        video.volume = 0.3;
    }
}

function playPause() {
    video.paused ? video.play() : video.pause();
}

function volumeUp() {
    if (video.volume <= 0.9) video.volume += 0.1;
}

function volumeDown() {
    if (video.volume >= 0.1) video.volume -= 0.1;
}

function seekRight() {
    video.currentTime += 5;
}

function seekLeft() {
    video.currentTime -= 5;
}

function vidFullscreen() {
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.mozRequestFullScreen) {
        video.mozRequestFullScreen();
    } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
    }
}

$(window).on('load', function () {
    playM3u8(window.location.href.split("#")[1])
    $('#video').on('click', function () { this.paused ? this.play() : this.pause(); });

    Mousetrap.bind('space', playPause);
    Mousetrap.bind('up', volumeUp);
    Mousetrap.bind('down', volumeDown);
    Mousetrap.bind('right', seekRight);
    Mousetrap.bind('left', seekLeft);
    Mousetrap.bind('f', vidFullscreen);

    // Share button logic
    $('#share-btn').click(function () {
        if (navigator.share) {
            navigator.share({
                title: document.title,
                text: 'Check out this video!',
                url: window.location.href,
            }).then(() => {
                console.log('Thanks for sharing!');
            }).catch((error) => {
                console.error('Error sharing', error);
            });
        } else {
            alert('Your browser does not support the Web Share API.');
        }
    });
});

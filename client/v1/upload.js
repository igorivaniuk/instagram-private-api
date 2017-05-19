var util = require("util");
var _ = require("underscore");
var Resource = require("./resource");
const CONSTANTS = require("./constants");
var Helpers = require('../../helpers');
var Promise = require("bluebird");

function Upload() {
    Resource.apply(this, arguments);
}

util.inherits(Upload, Resource);


module.exports = Upload;
var Exceptions = require('./exceptions');
var Request = require("./request");


Upload.prototype.parseParams = function (params) {
    var hash = {};
    hash.uploadId = params.upload_id;
    if(params.video_upload_urls && params.video_upload_urls.length){
        hash.uploadUrl = params.video_upload_urls[0].url;
        hash.uploadJob = params.video_upload_urls[0].job;
    }
    return hash;
};


Upload.photo = function (session, streamOrPath, uploadId, name, album) {
    var stream = Helpers.pathToStream(streamOrPath);
    // This compresion is just default one
    var compresion = {
        "lib_name": "jt",
        "lib_version": "1.3.0",
        "quality": "92"
    }
    var predictedUploadId = uploadId || new Date().getTime();
    var filename = (name || "pending_media_")+predictedUploadId+".jpg";
    var request = new Request(session);
    var data = {
        image_compression: JSON.stringify(compresion),
        upload_id: predictedUploadId
    };

    if (album) {
        data['is_sidecar'] = '1';
        if (uploadId) {
            data['media_type'] = '2';
        }
    }
    return request.setMethod('POST')
        .setResource('uploadPhoto')                    
        .generateUUID()
        .setData(data)
        .transform(function(opts){
            opts.formData.photo = {
                value: stream,
                options: {
                    filename: filename,
                    contentType: 'image/jpeg'
                }
            };
            return opts;
        })
        .send()
        .then(function(json) {
            return new Upload(session, json);    
        })
}

Upload.video = function(session,videoBufferOrPath,photoStreamOrPath, width, height, album){
    //Probably not the best way to upload video, best to use stream not to store full video in memory, but it's the easiest
    var predictedUploadId = new Date().getTime();
    var request = new Request(session);

    return Helpers.pathToBuffer(videoBufferOrPath)
        .then(function(buffer){
            var duration = _getVideoDurationMs(buffer);
            if(duration > 63000) throw new Error('Video is too long. Maximum: 63. Got: '+duration/1000);

            var params = {
                upload_id: predictedUploadId,
                media_type: 2,
                upload_media_duration_ms: Math.floor(duration),
                upload_media_height: height || 720,
                upload_media_width: width || 720
            };

            if (album) {
                params = {
                    upload_id: predictedUploadId,
                    is_sidecar: '1'
                };
            }

            return request
            .setMethod('POST')
            .setBodyType('form')
            .setResource('uploadVideo')
            .generateUUID()
            .setData(params)
            .send()
            .then(function(json) {
                return new Upload(session, json);
            })
            .then(function(uploadData){
                //Uploading video to url
                var sessionId = _generateSessionId(uploadData.params.uploadId);
                var chunkLength = 204800;
                var chunks = [];
                chunks.push({
                    data:buffer,
                    range:'bytes '+0+'-'+(buffer.length-1)+'/'+buffer.length
                });
                return Promise.mapSeries(chunks, function(chunk,i){
                        return _sendChunkedRequest(
                            session,uploadData.params.uploadUrl,
                            uploadData.params.uploadJob,
                            sessionId,chunk.data,chunk.range,album)
                    })
                    .then(function(results){
                        var videoUploadResult = results[results.length-1];
                        return {
                            delay:videoUploadResult.configure_delay_ms,
                            durationms:duration,
                            uploadId:uploadData.params.uploadId
                        }
                    })
                    .then(function(uploadData){
                        return Upload.photo(session,photoStreamOrPath,uploadData.uploadId,"cover_photo_",album)
                            .then(function(){
                                return uploadData;
                            })
                    })
            })
    })
}

function _getVideoDurationMs(buffer){
    var start = buffer.indexOf(new Buffer('mvhd')) + 17;
    var timeScale = buffer.readUInt32BE(start, 4);
    var duration = buffer.readUInt32BE(start + 4, 4);
    var movieLength = duration/timeScale;

    return movieLength*1000;
}

async function _sendChunkedRequest(session,url,job,sessionId,buffer,range,album){
    var headers = {
        'job': job,
        'Host': 'upload.instagram.com',
        'Session-ID': sessionId,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename=\\\"video.mov\\\"',
        'Content-Length': buffer.length,
        'Content-Range': range
    };
    if (album) {
        headers['Cookie'] = 'sessionid=' + await session.cookieStore.getSessionId()
    }
    return new Request(session)
        .setMethod('POST')
        .setBodyType('body')
        .setUrl(url)
        .generateUUID()
        .setHeaders(headers)
        .transform(function(opts){
            opts.body = buffer;
            return opts;
        })
        .send()
}

function _generateSessionId(uploadId){
    var text = (uploadId || "")+'-';
    var possible = "0123456789";

    for( var i=0; i < 9; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
}
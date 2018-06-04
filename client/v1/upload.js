var util = require("util");
var _ = require("lodash");
var Resource = require("./resource");
var Helpers = require('../../helpers');
var fs = require('fs');
var path = require('path');
var Promise = require("bluebird");
var camelKeys = require('camelcase-keys');

function Upload() {
    Resource.apply(this, arguments);
}

util.inherits(Upload, Resource);


module.exports = Upload;
var Exceptions = require('./exceptions');
var Request = require("./request");


Upload.prototype.parseParams = function (json) {
    var hash = camelKeys(json);
    if(json.video_upload_urls && json.video_upload_urls.length){
        hash.uploadUrl = json.video_upload_urls[0].url;
        hash.uploadJob = json.video_upload_urls[0].job;
    }
    return hash;
};


Upload.photoAlbum = function (session, filePath) {
    let pathInfo = path.parse(filePath);
    const code = Helpers.hashCode(pathInfo.base);
    const predictedUploadId = String(new Date().getTime());
    const filename = `pending_media_${code}.jpg`;
    const request = new Request(session);
    let data = {
        is_sidecar: '1',
        media_type:	'1',
        retry_context:	'{"num_step_auto_retry":0,"num_reupload":0,"num_step_manual_retry":0}',
        upload_id: predictedUploadId,
        image_compression: '{"lib_name":"jt","lib_version":"1.3.0","quality":"87"}'
    };
    return request.setMethod('POST')
        .setResource('uploadPhoto')
        .generateUUID()
        .setData(data)
        .transform(function(opts){
            opts.formData.photo = {
                value: fs.readFileSync(filePath),
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

Upload.photo = function (session, path, uploadId, name, album) {
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
                value: fs.readFileSync(path),
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
};

Upload.album = function (session, medias, caption, disableComments) {
    var uploadPromises = [];

    if(medias.length < 2 || medias.length > 10) {
        throw new Error('Invalid album size');
    }

    medias.forEach(function (media) {
        if(['photo', 'video'].indexOf(media.type) === -1) {
            throw new Error('Invalid media type: ' + media.type);
        }
        if(!media.data) {
            throw new Error('Data not specified.');
        }
        if(!media.size) {
            throw new Error('Size not specified.');
        }
        if(media.type === 'video') {
            if(!media.thumbnail) {
                throw new Error('Thumbnail not specified.');
            }
        }
        var aspect_ratio = (media.size[0] / media.size[1]).toFixed(2);
        if(aspect_ratio < 0.8 || aspect_ratio > 1.91) {
            throw new Error('Invalid media aspect ratio.');
        }

        if(media.type === 'photo') {
            uploadPromises.push(
                Upload.photo(session, media.data, undefined, undefined, true)
                    .then(function (payload) {
                        return Promise.resolve(Object.assign({}, {uploadId: payload.params.uploadId}, media));
                    })
            )
        }
        if(media.type === 'video') {
            uploadPromises.push(
                Upload.video(session, media.data, media.thumbnail, true)
                    .then(function (payload) {
                        return Promise.resolve(Object.assign({}, payload, media));
                    })
            )
        }
    });

    return Promise.all(uploadPromises);
};

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

const MAX_RESUMABLE_RETRIES = 5;

function offsetResumableHeaders(uploadParams) {
    return {
        'X-Instagram-Rupload-Params': JSON.stringify(uploadParams),
        'X-FB-HTTP-Engine': 'Liger'
    };
}

function offsetResumableReq(session, uploadUrl, uploadParams) {

    let offsetReq = new Request(session)
        .setMethod('GET')
        .setUrl(uploadUrl)
        .removeHeader('X-IG-Connection-Type')
        .removeHeader('X-IG-Capabilities')
        .setHeaders(offsetResumableHeaders(uploadParams));
    offsetReq.beforeParse = function (res) {
        let data = JSON.parse(res.body);
        if (typeof data.offset !== 'undefined') {
            res.body = JSON.stringify({...data, status: 'ok'});
        }
        return res;
    };

    return offsetReq;
}

/**
 *
 * @param {Session} session
 * @param {('video'|'photo')} type
 * @param {Object} options
 * @param {string} options.filePath
 * @param {string} options.uploadId
 * @param {number=} options.videoHeight
 * @param {number=} options.videoWidth
 * @returns {Promise.<*>}
 */
async function resumableUpload(session, type, options) {
    options = options || {};
    /**
     * @type Buffer
     */
    let buffer = await Helpers.pathToBuffer(options.filePath);
    let pathInfo = path.parse(options.filePath);
    let uploadParams;
    let duration;

    if (type === 'video') {
        duration = _getVideoDurationMs(buffer);
        if(duration > 63000) throw new Error('Video is too long. Maximum: 63. Got: '+duration/1000);

        uploadParams = {
            upload_media_height: options.videoHeight || 740,
            upload_media_width: options.videoWidth || 480,
            upload_media_duration_ms: String(Math.floor(duration)),
            upload_id: options.uploadId,
            media_type: '2'
        };
        if (options.album) {
            uploadParams['for_album'] = '1'
        }
    } else if (type === 'photo') {
        const compression = {
            'lib_name': 'jt',
            'lib_version': '1.3.0',
            'quality': '92'
        };

        uploadParams = {
            image_compression: JSON.stringify(compression),
            upload_id: options.uploadId,
            media_type: options.mediaType || '2'
        };
    } else {
        throw new Error('`type` params must be video or photo')
    }

    const entityName = [options.uploadId, 0, Helpers.hashCode(pathInfo.base)].join('_');
    let uploadUrl = `https://i.instagram.com/rupload_ig${type}/${entityName}`;

    const uploadHeaders = {
        ...offsetResumableHeaders(uploadParams),
        'X-Entity-Name': entityName,
        'X-Entity-Length': buffer.length,
        'X-Entity-Type': 'video/mp4',
        'Offset': 0
    };

    let offsetReq = offsetResumableReq(session, uploadUrl, uploadParams);

    let uploadReq = new Request(session)
        .setMethod('POST')
        .setUrl(uploadUrl)
        .setBodyType('body')
        .setHeaders(uploadHeaders);

    let attempt = 0;
    while (true) {
        if (++attempt > MAX_RESUMABLE_RETRIES) {
            throw new Error(`Cant upload ${type}, all retries have failed.`)
        }

        let json = await offsetReq.send();
        let offset = json.offset;
        try {
            await uploadReq
                .setHeader('Offset', offset)
                .transform((opts) => {
                    opts.body = buffer.slice(offset, buffer.length);
                    return opts;
                }).send();
        } catch (e) {
            continue;
        }

        return {uploadId: options.uploadId, durationms: duration};
    }
}

Upload.videoReuse = async function (session, videoPath, photoPath, width, height) {
    const predictedUploadId = String(new Date().getTime());

    let res = await resumableUpload(session, 'video', {
        uploadId: predictedUploadId,
        filePath: videoPath,
        videoHeight: height,
        videoWidth: width
    });

    await resumableUpload(session, 'photo', {
        uploadId: predictedUploadId,
        filePath: photoPath
    });

    return res;
};

Upload.videoStory = async function (session, videoPath, photoPath, width, height) {
    const predictedUploadId = String(new Date().getTime());

    let res = await resumableUpload(session, 'video', {
        uploadId: predictedUploadId,
        filePath: videoPath,
        videoHeight: height,
        videoWidth: width,
        album: true
    });

    await resumableUpload(session, 'photo', {
        uploadId: predictedUploadId,
        filePath: photoPath
    });

    return res;
};

Upload.photoReuse = async function (session, path, uploadId) {
    const predictedUploadId = uploadId || String(new Date().getTime());

    return await resumableUpload(session, 'photo', {
        uploadId: predictedUploadId,
        filePath: path,
        mediaType: 1
    });
};
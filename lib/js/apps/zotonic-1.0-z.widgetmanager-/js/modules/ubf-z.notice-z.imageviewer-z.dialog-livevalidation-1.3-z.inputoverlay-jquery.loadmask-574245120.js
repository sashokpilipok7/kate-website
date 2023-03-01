/* Zotonic basic Javascript library
----------------------------------------------------------

@package:   Zotonic 2009
@Author:    Tim Benniks <tim@timbenniks.nl>
@Author:    Marc Worrell <marc@worrell.nl>

Copyright 2009-2014 Tim Benniks, Marc Worrell

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Based on nitrogen.js which is copyright 2008-2009 Rusty Klophaus

---------------------------------------------------------- */

// Client state
var z_language              = "en";
var z_ua                    = "desktop";
var z_pageid                = '';
var z_userid;
var z_editor;

// Session state
var z_session_valid         = false;
var z_session_restart_count = 0;
var z_session_reload_check  = false;

// Transport to/from server
var z_websocket_host;
var z_ws                    = false;
var z_ws_pong_count         = 0;
var z_ws_ping_timeout;
var z_ws_ping_interval;
var z_comet;
var z_comet_poll_timeout;
var z_comet_reconnect_timeout = 1000;
var z_comet_poll_count      = 0;
var z_stream_starter;
var z_stream_start_timeout;
var z_default_form_postback = false;
var z_page_unloading        = false;
var z_transport_check_timer;
var z_transport_queue       = [];
var z_transport_acks        = [];
var z_transport_delegates   = {
    javascript: z_transport_delegate_javascript,
    session: z_transport_session_status,
    reload: z_session_invalid_dialog
};
var z_transport_retransmission_enabled = false;
var z_force_unload_beacon   = false;
var z_init_postback_forms_timeout = false;

var TRANSPORT_TIMEOUT       = 30000;
var TRANSPORT_TRIES         = 3;

var WEBSOCKET_PING_INTERVAL = 20000; // Send ping messages every 20 seconds
var ACTIVITY_PERIOD         = 5000;  // Inactive if silent for 5 seconds

// Misc state
var z_spinner_show_ct       = 0;  // Set when performing an AJAX callback
var z_last_active           = 0;
var z_input_updater         = false;
var z_drag_tag              = [];
var z_registered_events     = {};
var z_on_visible_checks     = [];
var z_on_visible_timer;
var z_unique_id_counter     = 0;


function z_set_page_id( page_id, user_id )
{
    ubf.add_spec('z_msg_v1', [
        "qos", "dup", "msg_id", "timestamp", "content_type", "delegate",
        "push_queue", "ua_class", "session_id", "page_id",
        "data"
        ]);
    ubf.add_spec('z_msg_ack', [
        "qos", "msg_id", "push_queue", "session_id", "page_id", "result"
        ]);
    ubf.add_spec('postback_notify', [
        "message", "trigger", "target", "data"
        ]);
    ubf.add_spec('postback_event', [
        "postback", "trigger", "target",
        "triggervalue", "data"
        ]);
    ubf.add_spec('session_state', [
        "page_id", "user_id"
        ]);
    ubf.add_spec('auth_change', [
        "page_id"
        ]);
    ubf.add_spec("unload_beacon", [
        "session_id",
        "page_id",
        ]);
    ubf.add_spec("rsc_update_done", [
        "action", "id", "pre_is_a", "post_is_a",
        "pre_props", "post_props" // Always empty
        ]);
    ubf.add_spec("media_replace_file", [
        "id",
        "medium" // Always empty
        ]);
    ubf.add_spec("edge_insert", [
        "subject_id", "predicate", "object_id", "edge_id"
        ]);
    ubf.add_spec("edge_delete", [
        "subject_id", "predicate", "object_id", "edge_id"
        ]);
    ubf.add_spec("edge_update", [
        "subject_id", "predicate", "object_id", "edge_id"
        ]);
    ubf.add_spec('q', [
        "q"
        ]);

    z_activity_init();

    if (z_pageid != page_id) {
        z_session_valid = true;
        z_pageid = page_id;
        z_userid = user_id;

        if (typeof pubzub == "object") {
            setTimeout(function() { pubzub.publish("~pagesession/pageinit", page_id); }, 10);
        }
    }
    $(window).bind("pageshow", function(event) {
        // After back button on iOS / Safari
        if (typeof event.originalEvent == 'object' && event.originalEvent.persisted) {
            z_page_unloading = false;
            setTimeout(function() {
                z_stream_onreload();
            }, 10);
        }
    });
    $(window).bind('beforeunload', function() {
        z_page_unloading = true;

        // Keep the connection open, but because the unloading flag is set
        // the connection will not be automatically restored if it is dropped.
        
        setTimeout(function() {
            z_page_unloading = false;
        }, 10000);
    });
    $(window).bind('unload', function() {
        var msg = {
            "_record": "unload_beacon",
            "page_id": z_pageid,
            "session_id": window.z_sid || undefined
        };

        // Stop the websocket. This prevents a connection interrupted error.
        z_websocket_stop();

        // Abort an open comet connection
        if (z_comet) {
            try { z_comet.abort(); } catch(e) { }
            z_comet = undefined;
        }

        if(navigator.sendBeacon) {
            navigator.sendBeacon("/beacon", ubf.encode(msg));
            return;
        }

        // If the browser doesn't have the beacon api, and we are forced to send the
     	// unload beacon we have to send it via a synchronous ajax request.
        if(z_force_unload_beacon) {
            $.ajax({url: "/beacon",
        	    type: "post",
        	    data: ubf.encode(msg),
        	    dataType: "text",
        	    contentType: "text/x-ubf",
        	    async: false});
        }
    });
}

/* Non modal dialogs
---------------------------------------------------------- */

function z_dialog_open(options)
{
    $.dialogAdd(options);
}

function z_dialog_close()
{
    $.dialogClose();
}

function z_dialog_confirm(options)
{
    var html,
        backdrop;

    if (typeof options.backdrop == 'undefined') {
        backdrop = options.backdrop
    } else {
        backdrop = true;
    }
    html = '<div class="confirm">' + options.text + '</div>'
         + '<div class="modal-footer">'
         + '<button class="btn btn-default z-dialog-cancel-button">'
         + (options.cancel||z_translate('Cancel'))
         + '</button>'
         + '<button class="btn btn-primary z-dialog-ok-button">'
         + (options.ok||z_translate('OK'))
         + '</button>'
         + '</div>';
    $.dialogAdd({
        title: (options.title||z_translate('Confirm')),
        text: html,
        width: (options.width),
        backdrop: backdrop
    });
    $(".z-dialog-cancel-button").click(function() { z_dialog_close(); });
    $(".z-dialog-ok-button").click(function() {
        z_dialog_close();
        if (options.on_confirm) options.on_confirm();
    });
}

function z_dialog_alert(options)
{
    var html,
        backdrop;

    if (typeof options.backdrop == 'undefined') {
        backdrop = options.backdrop
    } else {
        backdrop = true;
    }
    html = '<div class="confirm">' + options.text + '</div>'
         + '<div class="modal-footer">'
         + '<button class="btn btn-primary z-dialog-ok-button">'
         + (options.ok||z_translate('OK'))
         + '</button>'
         + '</div>';
    $.dialogAdd({
        title: (options.title||z_translate('Alert')),
        text: html,
        width: (options.width),
        backdrop: backdrop
    });
    $(".z-dialog-ok-button").click(function() {
        z_dialog_close();
        if (options.on_confirm) options.on_confirm();
    });
}

function z_dialog_overlay_open(options)
{
    var $overlay = $('.modal-overlay');
    if ($overlay.length > 0) {
        $overlay
            .html(options.html)
            .attr('class', 'modal-overlay')
            .show();
    } else {
        html = '<div class="modal-overlay">' +
               '<a href="#close" class="modal-overlay-close" onclick="return z_dialog_overlay_close()">&times;</a>' +
               options.html +
               '</div>';
        $('body').append(html);
    }
    if (options.class) {
        $('.modal-overlay').addClass(options.class);
    }
}

function z_dialog_overlay_close()
{
    $('.modal-overlay').remove();
    return false;
}

/* Growl messages
---------------------------------------------------------- */

function z_growl_add(message, stay, type)
{
    stay = stay || false;
    type = type || 'notice';

    $.noticeAdd(
    {
        text: message,
        stay: stay,
        type: type
    });

    if(type == 'error' && window.console)
    {
        console.error(message);
    }
}

function z_growl_close()
{
    $.noticeRemove($('.notice-item-wrapper'), 400);
}


/* Registered events for javascript triggered actions/postbacks
---------------------------------------------------------- */

function z_event_register(name, func)
{
    z_registered_events[name] = func;
}

function z_event_remove(name)
{
    delete z_registered_events[name];
}

function z_event(name, extraParams)
{
    if (z_registered_events[name])
    {
        z_registered_events[name](ensure_name_value(extraParams));
    }
    else if (window.console)
    {
        console.log("z_event: no registered event named: '"+name+"'");
    }
}

/* Call the server side notifier for {postback_notify, Message, Context}
---------------------------------------------------------- */

function z_notify(message, extraParams)
{
    var trigger_id = '';
    var params = extraParams || [];

    if (typeof params == 'object' && params.z_trigger_id !== undefined) {
        trigger_id = params.z_trigger_id;
        delete params.z_trigger_id;
    }
    var notify = {
        _record: "postback_notify",
        message: message,
        trigger: trigger_id,
        target: params.z_target_id || undefined,
        data: {
            _record: 'q',
            q: ensure_name_value(params) || []
        }
    };
    var delegate = params.z_delegate || 'notify';
    var options = {
        trigger_id: trigger_id
    };
    if (trigger_id) {
        options.ack = function(_ack_msg, _options) {
            z_unmask(trigger_id);
        };
    }
    return z_transport(delegate, 'ubf', notify, options);
}


/* Session handling and restarts
---------------------------------------------------------- */


function z_session_restart(invalid_page_id)
{
    if (z_session_valid) {
        z_session_valid = false;
        z_session_restart_count = 0;
    }
    setTimeout(function() { z_session_restart_check(invalid_page_id); }, 50);
}

function z_session_restart_check(invalid_page_id)
{
    if (z_pageid == invalid_page_id) {
        if (z_spinner_show_ct === 0) {
            if (z_session_restart_count == 3 || !z_pageid) {
                z_session_invalid_reload(z_pageid);
            } else {
                z_session_restart_count++;
                z_transport('session', 'ubf', 'ensure', {is_expect_cookie: true});
            }
        } else {
            setTimeout(function() { z_session_restart_check(invalid_page_id); }, 200);
        }
    }
}

function z_session_status_ok(page_id, user_id)
{
    if (page_id != z_pageid || user_id != z_userid) {
        var status = {
            status: "restart",
            user_id: user_id,
            page_id: page_id,
            prev_user_id: z_userid,
            prev_page_id: z_pageid
        };

        z_pageid = page_id;
        z_userid = user_id;

        z_transport_queue = [];
        z_transport_acks = [];

        // checks pubzub registry for the local "session" topic
        // if any handlers then publish the new user to the topic
        // if no handlers then the default reload dialog is shown
        if (typeof pubzub == "object" && pubzub.subscribers("~pagesession/session").length > 0) {
            z_session_valid = true;
            pubzub.publish("~pagesession/session", status);
            z_stream_restart();
        } else {
            z_session_invalid_reload(z_pageid, status);
        }
    }
}

function z_session_invalid_reload(page_id, status)
{
    if (page_id == z_pageid) {
        if (z_spinner_show_ct === 0 && !z_page_unloading) {
            z_transport_delegates.reload(status);
        } else {
            setTimeout(function() {
                z_session_invalid_reload(page_id, status);
            }, 1000);
        }
    }
}

// Default action for delegates.reload
function z_session_invalid_dialog()
{
    var is_editing = false;

    z_editor_save($('body'));
    $('textarea').each(function() {
        is_editing = is_editing || ($(this).val() !== "");
    });

    if (is_editing) {
        z_dialog_confirm({
            title: z_translate("Reload"),
            text: "<p>" +
                z_translate("Your session has expired or is invalid. Reload the page to continue.") +
                "</p>",
            ok: z_translate("Reload"),
            on_confirm: function() { z_reload(); }
        });
    } else {
        z_reload();
    }
}

/* Track activity, for stopping inactive sessions
---------------------------------------------------------- */

function z_activity_init()
{
    /* Use passive event capturing when it is supported */
    var passive_if_supported = false;

    try {
        window.addEventListener("test", null,
            Object.defineProperty({}, "passive", {
                get: function() {
                    passive_if_supported = {
                        passive: false
                    };
                }
            }));
    } catch(err) {
    }

    z_last_active = 0;
    z_activity_event();

    document.addEventListener("visibilitychange", z_activity_event, passive_if_supported);
    document.addEventListener("scroll", z_activity_event, passive_if_supported);
    document.addEventListener("keydown", z_activity_event, passive_if_supported);
    document.addEventListener("mousemove", z_activity_event, passive_if_supported);
    document.addEventListener("click", z_activity_event, passive_if_supported);
    document.addEventListener("focus", z_activity_event, passive_if_supported);
}

function z_activity_ignore() {
    document.removeEventListener("visibilitychange", z_activity_event);
    document.removeEventListener("scroll", z_activity_event);
    document.removeEventListener("keydown", z_activity_event);
    document.removeEventListener("mousemove", z_activity_event);
    document.removeEventListener("click", z_activity_event);
    document.removeEventListener("focus", z_activity_event);

    z_last_active = null;
}

function z_activity_event()
{
    if (!document.hidden) {
        z_last_active = Date.now();
    }
}

function z_is_active(period)
{
    period = period || ACTIVITY_PERIOD;
    var now = Date.now();

    /* Return true when we are ignoring activity monitoring */
    if(z_last_active === null) return true;
    

    return z_last_active > now - period;
}


/* Transport between user-agent and server
---------------------------------------------------------- */

// Register a handler for incoming data (aka delegates)
function z_transport_delegate_register(name, func)
{
    z_transport_delegates[name] = func;
}

// Called for 'session' transport delegates, handles the session status
function z_transport_session_status(data, msg)
{
    switch (data)
    {
        case 'session_invalid':
            if (window.z_sid) {
                window.z_sid = undefined;
            }
            if (z_session_reload_check) {
                z_reload();
            } else {
                z_session_reload_check = false;
                z_session_restart(z_pageid);
            }
            break;
        case 'page_invalid':
            if (z_session_reload_check) {
                z_reload();
            } else {
                z_session_reload_check = false;
                z_session_restart(z_pageid);
            }
            break;
        case 'ok':
            z_session_valid = true;
            if (z_session_reload_check) {
                z_session_reload_check = false;
                z_stream_restart();
            }
            break;
        default:
            if (typeof data == 'object') {
                switch (data._record) {
                    case 'session_state':
                        z_session_status_ok(data.page_id, data.user_id);
                        break;
                    case 'auth_change':
                        if (data.page_id == z_pageid) {
                            // The user-id of the session is changed.
                            // A new session cookie might still be on its way, so wait a bit
                            setTimeout(function() {
                                z_session_restart(z_pageid);
                            }, 1000);
                        }
                        break;
                    default:
                        console.log("Transport, unknown session status ", data);
                        break;
                }
            } else {
                console.log("Transport, unknown session status ", data);
            }
            break;
    }
}


// Queue any data to be transported to the server
function z_transport(delegate, content_type, data, options)
{
    var msg_id = z_unique_id(true);

    if (!z_pageid) {
        z_transport_wait(msg_id, delegate, content_type, data, options);
        return msg_id;
    } else {
        return z_transport_do(msg_id, delegate, content_type, data, options);
    }
}

function z_transport_wait(msg_id, delegate, content_type, data, options)
{
    if (!z_pageid) {
        setTimeout(function() {
                z_transport_wait(msg_id, delegate, content_type, data, options);
            }, 100);
    } else {
        return z_transport_do(msg_id, delegate, content_type, data, options);
    }
}


function z_transport_do(msg_id, delegate, content_type, data, options)
{
    var timestamp = new Date().getTime();

    options = options || {};
    options.transport = options.transport || '';

    if (typeof options.qos == 'undefined') {
        if (options.ack) {
            options.qos = 1;
        } else {
            options.qos = 0;
        }
    }
    var msg = {
            "_record": "z_msg_v1",
            "qos": options.qos,
            "dup": false,
            "msg_id": msg_id,
            "timestamp": timestamp,
            "content_type": z_transport_content_type(content_type),
            "delegate": z_transport_delegate(delegate),
            "ua_class": ubf.constant(z_ua),
            "page_id": z_pageid,
            "session_id": window.z_sid || undefined,
            "data": data
        };

    options.timeout = options.timeout || TRANSPORT_TIMEOUT;
    if (options.qos > 0 && options.transport !== 'form') {
        var t = setTimeout(function() {
                    z_transport_timeout(msg_id);
                }, options.timeout);
        z_transport_acks[msg_id] = {
            msg: msg,
            msg_id: msg_id,
            options: options,
            timestamp: timestamp,
            timeout_timer: t,
            timeout_count: 0,
            is_queued: true
        };
    }

    if (options.transport == 'form') {
        z_transport_form({
            msg: msg,
            msg_id: msg_id,
            options: options
        });
    } else {
        z_transport_queue.push({
            msg: msg,
            msg_id: msg_id,
            options: options
        });
        z_transport_check();
    }
    return msg_id;
}

// Map some special content types to an atom
function z_transport_content_type(content_type)
{
    switch (content_type || 'ubf')
    {
        case 'ubf':        return ubf.constant('ubf');
        case 'json':       return ubf.constant('json');
        case 'form':       return ubf.constant('form');
        case 'javascript': return ubf.constant('javascript');
        case 'text':       return ubf.constant('text');
        default: return content_type;
    }
}

// Map some special delegates to an atom
function z_transport_delegate(delegate)
{
    switch (delegate)
    {
        case 'mqtt':     return ubf.constant('mqtt');
        case 'notify':   return ubf.constant('notify');
        case 'postback': return ubf.constant('postback');
        case 'session':  return ubf.constant('session');
        case '$ping':    return ubf.constant('$ping');
        default: return delegate;
    }
}

// Ensure that a transport is scheduled for fetching data queued at the server
function z_transport_ensure()
{
    if (z_transport_queue.length === 0 && !z_websocket_is_connected()) {
        z_transport('$ping');
    }
}

function z_transport_incoming(data)
{
    if (data !== undefined && data.length > 0) {
        var msgs = ubf.decode(data);

        if (typeof msgs == 'object' && msgs.ubf_type == ubf.LIST) {
            for (var i=0; i<msgs.length; i++) {
                z_transport_incoming_msg(msgs[i]);
            }
        } else {
            z_transport_incoming_msg(msgs);
        }
    }
}

function z_transport_incoming_msg(msg)
{
    switch (msg._record)
    {
        case 'z_msg_v1':
            z_transport_maybe_ack(msg);
            var data = z_transport_incoming_data_decode(msg.content_type.valueOf(), msg.data);
            var fun = z_transport_delegates[msg.delegate.valueOf()];
            if (typeof fun == 'function') {
                fun(data, msg);
            } else {
                console.log("No delegate registered for ",msg);
            }
            break;
        case 'z_msg_ack':
            if (!z_websocket_pong(msg) && typeof z_transport_acks[msg.msg_id] == 'object') {
                var ack = z_transport_acks[msg.msg_id];
                delete z_transport_acks[msg.msg_id];

                if (ack.timeout_timer) {
                    clearTimeout(ack.timeout_timer);
                }
                if (typeof ack.options.ack == 'function') {
                    ack.options.ack(msg, ack.options);
                }
            }
            break;
        default:
            console.log("Don't know where to delegate incoming message ", msg);
            break;
    }
}

function z_transport_delegate_javascript(data, _msg)
{
    if (z_init_postback_forms_timeout) {
        clearTimeout(z_init_postback_forms_timeout);
    }
    eval(data);
    z_init_postback_forms_timeout = setTimeout(function() {
            z_init_postback_forms_timeout = false;
            z_init_postback_forms();
        }, 10);
}

function z_transport_maybe_ack(msg)
{
    if (msg.qos >= 1) {
        var ack = {
            "_record": "z_msg_ack",
            "qos": msg.qos,
            "msg_id": msg.msg_id,
            "push_queue": msg.push_queue,
            "session_id": window.z_sid || undefined,
            "page_id": msg.page_id || z_pageid
        };
        z_transport_queue.push({
            msg: ack,
            msg_id: msg.msg_id,
            options: {}
        });
        z_transport_check();
    }
}

// If a transport times-out whilst in transit then it is reposted
function z_transport_timeout(msg_id)
{
    z_log_error("Transport timeout for message: "+msg_id, "zotonic-1.0.js", 0, null);

    if (typeof z_transport_acks[msg_id] == 'object') {
        if (z_transport_acks[msg_id].timeout_count++ < TRANSPORT_TRIES) {
            // Requeue the request (if it is not waiting in the queue)
            if (!z_transport_acks[msg_id].is_queued && z_transport_retransmission_enabled) {
                z_transport_acks[msg_id].msg.dup = true;
                z_transport_queue.push({
                    msg: z_transport_acks[msg_id].msg,
                    msg_id: msg_id,
                    options: z_transport_acks[msg_id].options || {}
                });
                z_transport_acks[msg_id].is_queued = true;
            }
            z_transport_acks[msg_id].timeout_timer = setTimeout(function() {
                z_transport_timeout(msg_id);
            }, z_transport_acks[msg_id].options.timeout);
        } else {
            // Final timeout, remove from all queues
            if (z_transport_acks[msg_id].fail) {
                z_transport_acks[msg_id].fail(msg_id, z_transport_acks[msg_id].options);
            }
            if (z_transport_acks[msg_id].is_queued) {
                for (var i=0; i<z_transport_queue.length; i++) {
                    if (z_transport_queue[i].msg_id == msg_id) {
                        z_transport_queue.splice(i,i);
                        break;
                    }
                }
            }
            delete z_transport_acks[msg_id];
        }
    }
}

function z_transport_incoming_data_decode(type, data)
{
    switch (type)
    {
        case 'ubf':
            // Decoded by decoding the z_msg_v1 record
            return data;
        case 'json':
            return $.parseJSON(data.valueOf());
        case 'javascript':
            return data.valueOf();
        case 'form':
            return $.parseQuery(data.valueOf());
        case 'text':
            return data.valueOf();
        default:
            console.log("Unknown message data format: ", type, data);
            return data;
    }
}


// Queue form data to be transported to the server
// This is called by the server generated javascript and jquery triggered postback events.
// 'transport' is one of: '', 'ajax', 'form'
function z_queue_postback(trigger_id, postback, extraParams, noTriggerValue, transport, optPostForm)
{
    var triggervalue = '';
    var trigger;

    if (transport === true) {
        transport = 'ajax';
    }
    if (trigger_id) {
        trigger = $('#'+trigger_id).get(0);
    }
    if (trigger && !noTriggerValue) {
        if ($(trigger).is(":checkbox") || $(trigger).is(":radio")) {
            if ($(trigger).is(":checked")) {
                triggervalue = $(trigger).val() || 'on';
            }
        } else {
            var nodeName = trigger.nodeName.toLowerCase();
            if (nodeName == 'input' || nodeName == 'button' || nodeName == 'textarea' || nodeName == 'select') {
                triggervalue = $(trigger).val() || '';
            }
        }
    }
    extraParams = extraParams || [];
    // extraParams.push({name: 'triggervalue', value: triggervalue});

    var pb_event = {
        _record: "postback_event",
        postback: postback,
        trigger: trigger_id,
        target: extraParams.target_id || undefined,
        triggervalue: triggervalue,
        data: {
            _record: 'q',
            q: ensure_name_value(extraParams) || []
        }
    };

    if (!transport) {
        if ((trigger_id == "logon_form") || (trigger && $(trigger).hasClass("setcookie"))) {
            transport = 'ajax';
        }
    }

    // logon_form and .setcookie forms are always posted, as they will set cookies.
    var options = {
        transport: transport,
        trigger_id: trigger_id,
        post_form: optPostForm
    };
    if (trigger_id) {
        options.ack = function(_ack_msg, _options) {
            z_unmask(trigger_id);
        };
    }
    z_transport('postback', 'ubf', pb_event, options);
}

function z_postback_opt_qs(extraParams)
{
    if (typeof extraParams == 'object' && extraParams instanceof Array) {
        return {
            _record: "q",
            q: ensure_name_value(extraParams)
        };
    } else {
        return extraParams;
    }
}

function z_transport_check()
{
    if (z_transport_queue.length > 0)
    {
        // Delay transport messages till the z_pageid is initialized.
        if (z_pageid !== '') {
            var qmsg = z_transport_queue.shift();

            if (z_transport_acks[qmsg.msg_id]) {
                z_transport_acks[qmsg.msg_id].is_queued = false;
            }
            if (!qmsg.page_id) {
                qmsg.page_id = z_pageid;
            }
            z_do_transport(qmsg);
        } else if (!z_transport_check_timer) {
            z_transport_check_timer = setTimeout(function() { z_transport_check_timer = undefined; z_transport_check(); }, 50);
        }
    }
}

function z_do_transport(qmsg)
{
    var data = ubf.encode(qmsg.msg);
    if (qmsg.options.transport == 'ajax' || !z_websocket_is_connected() || !z_pageid) {
        z_ajax(qmsg.options, data);
    } else {
        z_ws.send(data);
    }
}

function z_ajax(options, data)
{
    z_start_spinner();
    $.ajax({
        url: '/postback',
        type: 'post',
        data: data,
        dataType: 'ubf text',
        accepts: {ubf: 'text/x-ubf'},
        converters: {"text ubf": window.String},
        contentType: 'text/x-ubf',
        async: true,
        success: function(received_data, textStatus)
        {
            try
            {
                z_transport_incoming(received_data);
                z_unmask(options.trigger_id);
            }
            catch(e)
            {
                console.log("Error evaluating ajax return value: ", received_data);
                $.misc.error("Error evaluating ajax return value: " + received_data, e);
            }
            setTimeout(function() { z_stop_spinner(); z_transport_check(); }, 0);
        },
        error: function(xmlHttpRequest, textStatus, errorThrown)
        {
            z_stop_spinner();
            z_unmask_error(options.trigger_id);
            if (!z_page_unloading) {
                if (textStatus == 'error') {
                    $.misc.error("Error fetching data from server.");
                } else {
                    $.misc.error("Error fetching data from server: " + textStatus);
                }
            }
        }
    });
}

function z_fetch_cookies()
{
    $.ajax({
        url: '/z_session/cookies',
        type: 'post',
        dataType: 'text'
    });
}

function z_unmask(id)
{
    if (id)
    {
        var trigger;
        if (id.charAt(0) == ' ') {
            trigger = $(id);
        } else {
            trigger = $('#'+id);
        }
        trigger.each(function() { try { $(this).unmask(); } catch (e) {}});
        trigger.each(function() { $(this).removeClass("z_error_upload"); });
    }
}

function z_unmask_error(id)
{
    if (id)
    {
        var trigger;
        if (id.charAt(0) == ' ') {
            trigger = $(id);
        } else {
            trigger = $('#'+id);
        }
        z_unmask(id);
        trigger.each(function() { try { $(this).unmask(); } catch (e) {}});
        trigger.each(function() { $(this).addClass("z_error_upload"); });
    }
}


function z_progress(id, value)
{
    if (id)
    {
        var trigger = $('#'+id).get(0);

        if (trigger.nodeName.toLowerCase() == 'form')
        {
            try { $(trigger).maskProgress(value); } catch (e) {}
        }
    }
}

function z_reload(args)
{
    var page = $('#logon_form input[name="page"]');
    z_start_spinner();
    if (page.length > 0 && page.val() !== "" && page.val() !== '#reload') {
        window.location.href = window.location.protocol+"//"+window.location.host+page.val();
    } else {
        if (typeof args == "undefined")
            window.location.reload(true);
        else {
            var qs = ensure_name_value(args);
            var href;

            if (qs.length == 1 &&  typeof args.z_language == "string") {
                if (  window.location.pathname.substring(0,2+z_language.length) == "/"+z_language+"/") {
                    href = window.location.protocol+"//"+window.location.host
                            +"/"+args.z_language+"/"
                            +window.location.pathname.substring(2+args.z_language.length);
                } else {
                    href = window.location.protocol+"//"+window.location.host
                            +"/"+args.z_language
                            +window.location.pathname;
                }
                window.location.href = href + window.location.search;
            } else {
                href = window.location.protocol+"//"+window.location.host+window.location.pathname;
                if (window.location.search == "") {
                    window.location.href = href + '?' + $.param(qs);
                } else {
                    var loc_qs = $.parseQuery();
                    for (var prop in loc_qs) {
                        if (typeof loc_qs[prop] != "undefined" && typeof args[prop] == "undefined")
                            qs.push({name: prop, value: loc_qs[prop]});
                    }
                    window.location.href = href + "?" + $.param(qs);
                }
            }
        }
    }
}

/* translations
---------------------------------------------------------- */

function z_translate(text)
{
    if (typeof z_translations != "undefined" && typeof z_translations[text] != "undefined")
        return z_translations[text];
    return text;
}

function z_translation_set(text, trans)
{
    if (typeof z_translations == "undefined") {
        z_translations = {};
    }
    z_translations[text] = trans;
}


/* Render text as html nodes
---------------------------------------------------------- */

function z_text_to_nodes(text)
{
    var text1 = $.trim(text);

    if (text1 === "") {
        return $("");
    } else {
        var $ns;
        if (text1.charAt(0) == "<" && text1.charAt(text1.length-1) == ">") {
            $ns = $(text);
        } else {
            $ns = $("<span></span>"+text+"<span></span>").slice(1,-1);
        }
        return $ns.filter(function(i) { return $ns[i].nodeType != 3 || $ns[i].nodeValue.trim() !== ""; });
    }
}

/* WYSYWIG editor
---------------------------------------------------------- */

function z_editor_init()
{
    if (z_editor !== undefined) {
        z_editor.init();
    }
}

function z_editor_add(element)
{
    if (z_editor !== undefined) {
        var $element = (typeof element == "string") ? $(element) : element;
        z_editor.add($element);
    }
}

function z_editor_save(element)
{
    if (z_editor !== undefined) {
        var $element = (typeof element == "string") ? $(element) : element;
        z_editor.save($element);
    }
}

function z_editor_remove(element)
{
    if (z_editor !== undefined) {
        var $element = (typeof element == "string") ? $(element) : element;
        z_editor.remove($element);
    }
}

/* Support legacy code */

function z_tinymce_init()
{
    z_editor_init();
}

function z_tinymce_add($element)
{
    z_editor_add($element);
}

function z_tinymce_save($element)
{
    z_editor_save($element);
}

function z_tinymce_remove($element)
{
    z_editor_remove($element);
}

/* Comet long poll or WebSockets connection
---------------------------------------------------------- */

function z_stream_start(_host, websocket_host)
{
    if (!z_session_valid) {
        setTimeout(function() {
            z_stream_start(_host, websocket_host);
        }, 100);
    } else {
        z_websocket_host = websocket_host || window.location.host;
        z_stream_restart();
    }
}

function z_stream_onreload()
{
    z_websocket_stop();

    if (z_comet) {
        try { z_comet.abort(); } catch(e) { }
        z_comet = undefined;
    }
    z_session_reload_check = true;
    z_page_unloading = false;
    z_transport('session', 'ubf', 'check', { transport: 'ajax' });
}

function z_stream_restart()
{
    if (z_websocket_host) {
        z_timeout_comet_poll_ajax(1000);
        if ("WebSocket" in window) {
            setTimeout(function() { z_websocket_start(); }, 200);
        }
    }
}

function z_stream_is_connected()
{
    return z_websocket_is_connected() || z_comet_is_connected();
}

function z_comet_poll_ajax()
{
    // Do not start a new poll when there is already a poll running.
    if (z_comet) return;

    if (z_ws_pong_count === 0 && z_session_valid && !z_page_unloading)
    {
        z_comet_poll_count++;
        var msg = ubf.encode({
                "_record": "z_msg_v1",
                "qos": 0,
                "dup" : false,
                "msg_id": '$comet-'+z_pageid+'-'+z_comet_poll_count,
                "timestamp": new Date().getTime(),
                "content_type": ubf.constant("ubf"),
                "delegate": ubf.constant('$comet'),
                "ua_class": ubf.constant(z_ua),
                "page_id": z_pageid,
                "session_id": window.z_sid || undefined,
                "data": {
                    count: z_comet_poll_count,
                    is_active: z_is_active()
                }
            });
        z_comet = $.ajax({
            url: window.location.protocol + '//' + window.location.host + '/comet',
            type:'post',
            data: msg,
            dataType: 'ubf text',
            accepts: {ubf: "text/x-ubf"},
            converters: {"text ubf": window.String},
            contentType: 'text/x-ubf',
            statusCode: {
                    /* Handle incoming data */
                    200: function(data, _textStatus) {
                        z_transport_handle_push_data(data);
                        z_timeout_comet_poll_ajax(100);
                    },
                    204: function() {
                        z_timeout_comet_poll_ajax(1000);
                    }
                },
            error: function(xmlHttpRequest, textStatus, errorThrown) {
                       setTimeout(function() { z_comet_poll_ajax(); }, z_comet_reconnect_timeout);
                       if(z_comet_reconnect_timeout < 60000)
                           z_comet_reconnect_timeout = z_comet_reconnect_timeout * 2;
                   }
        }).done(function() {
            z_comet = undefined;
        });
    }
    else
    {
        z_timeout_comet_poll_ajax(5000);
    }
}


function z_comet_is_connected()
{
    return z_comet && z_comet.readyState != 0;
}

function z_timeout_comet_poll_ajax(timeout)
{
    if (z_comet_poll_timeout) {
        clearTimeout(z_comet_poll_timeout);
    }
    z_comet_poll_timeout = setTimeout(function() {
        z_comet_poll_timeout = false;
        z_comet_reconnect_timeout = 1000;
        z_comet_poll_ajax();
    }, timeout);
}


function z_transport_handle_push_data(data)
{
    try
    {
        z_transport_incoming(data);
    }
    catch (e)
    {
        console.log("Error evaluating push return value: ", data);
        $.misc.error("Error evaluating push return value: " + data, e);
    }
}


function z_websocket_start()
{
    // Do not start a new websocket when there is already a websocket.
    if(z_ws) return; 

    var protocol = "ws:";
    if (window.location.protocol == "https:") {
        protocol = "wss:";
    }

    try {
        z_ws = new WebSocket(protocol+"//"+z_websocket_host+"/websocket");
    } catch (e) {
        z_ws_pong_count = 0;
    }

    z_ws.onopen = z_websocket_ping;
    z_ws.onerror = z_websocket_restart;
    z_ws.onclose = z_websocket_restart;

    z_ws.onmessage = function (evt) {
        z_transport_handle_push_data(evt.data);
        setTimeout(function() { z_transport_check(); }, 0);
    };
}

function z_websocket_stop()
{
    if (!z_ws) return;

    z_ws.onclose = undefined;
    z_ws.onerror = undefined;
    z_ws.onmessage = undefined;

    try {
        z_ws.close();
    } catch(e) {
        // closing an already closed ws can raise exceptions.
    }
    z_ws = undefined;
}

function z_websocket_ping()
{
    z_clear_ws_ping_timeout();
    z_ws_ping_timeout = setTimeout(z_websocket_restart, 5000);

    if (z_ws && z_ws.readyState == 1) {
        var msg = ubf.encode({
                    "_record": "z_msg_v1",
                    "qos": 1,
                    "dup" : false,
                    "msg_id": '$ws-'+z_pageid,
                    "timestamp": new Date().getTime(),
                    "content_type": ubf.constant("ubf"),
                    "delegate": ubf.constant('$ping'),
                    "ua_class": ubf.constant(z_ua),
                    "page_id": z_pageid,
                    "session_id": window.z_sid || undefined,
                    "data": {
                        count: z_ws_pong_count,
                        is_active: z_is_active(WEBSOCKET_PING_INTERVAL)
                    }
                });
        z_ws.send(msg);
    }
}

function z_clear_ws_ping_timeout()
{
    if (z_ws_ping_timeout) {
        clearTimeout(z_ws_ping_timeout);
        z_ws_ping_timeout = undefined;
    }
}

function z_clear_ws_ping_interval()
{
    if (z_ws_ping_interval) {
        clearTimeout(z_ws_ping_interval);
        z_ws_ping_interval = undefined;
    }
}

function z_websocket_pong( msg )
{
    if (msg.msg_id == '$ws-'+z_pageid) {
        z_clear_ws_ping_timeout();

        z_clear_ws_ping_interval();
        z_ws_ping_interval = setTimeout(z_websocket_ping, WEBSOCKET_PING_INTERVAL);

        z_ws_pong_count++;

        return true;
    }

    return false;
}

function z_websocket_is_connected()
{
    return z_ws && z_ws.readyState == 1 && z_ws_pong_count > 0;
}

function z_websocket_restart(e)
{
    z_clear_ws_ping_timeout();
    z_clear_ws_ping_interval();

    z_websocket_stop();

    if (z_ws_pong_count > 0 && z_session_valid && !z_page_unloading) {
        z_ws_pong_count = 0;
        z_websocket_start();
    }
}


/* Utility functions
---------------------------------------------------------- */

// Should an event be canceled or passed through.
function z_opt_cancel(obj)
{
    if(typeof obj.nodeName == 'undefined')
        return false;

    var nodeName = obj.nodeName.toLowerCase();
    var nodeType = $(obj).attr("type");

    if (nodeName == 'input' &&  (nodeType == 'checkbox' || nodeType == 'radio'))
    {
        return true;
    }
    else
    {
        return false;
    }
}

function z_is_enter_key(event)
{
    return (event && event.keyCode == 13);
}


function z_has_flash()
{
    if (navigator.plugins && navigator.plugins.length>0) {
        var type = 'application/x-shockwave-flash';
        var mimeTypes = navigator.mimeTypes;
        return (mimeTypes && mimeTypes[type] && mimeTypes[type].enabledPlugin);
    } else if(navigator.appVersion.indexOf("Mac")==-1 && window.execScript) {
        try {
            obj = new ActiveXObject("ShockwaveFlash.ShockwaveFlash");
            return true;
        } catch(err) {
            return false;
        }
    }
    return false;
}


function z_ensure_id(elt)
{
    var id = $(elt).attr('id');
    if (id === undefined || id === "") {
        id = z_unique_id();
        $(elt).attr('id', id);
    }
    return id;
}

function z_unique_id(no_dom_check)
{
    var id;
    do {
        id = '-z-' + z_unique_id_counter++;
    } while (!no_dom_check && $('#'+id).length > 0);
    return id;
}


/* Spinner, show when waiting for a postback
---------------------------------------------------------- */

function z_start_spinner()
{
    if (z_spinner_show_ct++ === 0)
    {
        $(document.body).addClass('wait');
        $('#spinner').fadeIn(100);
    }
}

function z_stop_spinner()
{
    if (--z_spinner_show_ct === 0)
    {
        $('#spinner').fadeOut(100);
        $(document.body).removeClass('wait');
    }
    else if (z_spinner_show_ct < 0) {
        z_spinner_show_ct = 0;
    }
}


/* Drag & drop interface to the postback
---------------------------------------------------------- */

function z_draggable(dragObj, dragOptions, dragTag)
{
    dragObj.draggable(dragOptions).data("z_drag_tag", dragTag);
    z_drag_tag[dragObj.attr('id')] = dragTag;
}

function z_droppable(dropObj, dropOptions, dropPostbackInfo)
{
    dropOptions.greedy = true;
    dropOptions.drop = function(ev, ui)
    {
        var dragTag = $(ui.draggable[0]).data("z_drag_tag");
        var dragItem = new Array({name: 'drag_item', value: dragTag});
        z_queue_postback(this.id, dropPostbackInfo, dragItem, true);
    };

    $(dropObj).droppable(dropOptions);
}


/* Sorter and sortables interface to the postback
---------------------------------------------------------- */

function z_sortable(sortableObj, sortTag)
{
    sortableObj.data("z_sort_tag", sortTag);
}

function z_sorter(sortBlock, sortOptions, sortPostbackInfo)
{
    sortOptions.update = function()
    {
        var sortItems = "";

        for (var i = 0; i < this.childNodes.length; i++)
        {
            var sortTag = $(this.childNodes[i]).data("z_sort_tag");
            if (sortTag)
            {
                if (sortItems !== "")
                {
                    sortItems += ",";
                }
                sortItems += sortTag;
            }
        }

        var sortItem = new Array({name: 'sort_items', value: sortItems});

        z_queue_postback(this.id, sortPostbackInfo, sortItem, true);
    };
    sortOptions.receive = function (ev, ui) {
        var $target = $(this).data().uiSortable.element;
        var $source = $(ui.sender);
        $target.data('z_sort_tag', $source.data('z_drag_tag'));
    };
    sortOptions.helper = 'clone';
    $(sortBlock).sortable(sortOptions);
}


/* typeselect input field
---------------------------------------------------------- */

function z_typeselect(ElementId, postbackInfo)
{
    if (z_input_updater)
    {
        clearTimeout(z_input_updater);
        z_input_updater = false;
    }

    z_input_updater = setTimeout(function()
    {
        var obj = $('#'+ElementId);

        if(obj.val().length >= 2)
        {
            obj.addClass('loading');
            z_queue_postback(ElementId, postbackInfo);
        }
    }, 400);
}


/* Lazy loading of content, based on visibility of an element
---------------------------------------------------------- */

function z_on_visible(CssSelector, Func)
{
    z_on_visible_checks.push({selector: CssSelector, func: Func});
    if (z_on_visible_timer == undefined) {
        z_on_visible_timer = setInterval(function() {
            z_on_visible_check();
        }, 350);
    }
}

function z_on_visible_check()
{
    for (var i = 0; i < z_on_visible_checks.length; i++) {
        var elt = $(z_on_visible_checks[i].selector).get(0);
        if (elt != undefined) {
            if ($(elt).is(":visible") && isScrolledIntoView(elt)) {
                z_on_visible_checks[i].func.call(elt);
                z_on_visible_checks.splice(i, 1);
            }
        }
    }
    if (z_on_visible_checks.length == 0) {
        clearInterval(z_on_visible_timer);
        z_on_visible_timer = undefined;
    }
}


function isScrolledIntoView(elem)
{
    var docViewTop = $(window).scrollTop();
    var docViewBottom = docViewTop + $(window).height();

    var elemTop = $(elem).offset().top;
    var elemBottom = elemTop + $(elem).height();

    return (elemBottom >= docViewTop) && (elemTop <= docViewBottom);
    // && (elemBottom <= docViewBottom) &&  (elemTop >= docViewTop);
}


/* Error handling
----------------------------------------------------------

Fetch the error event and log it to the server.
Which should log it in a separate ui error log.

---------------------------------------------------------- */

var oldOnError = window.onerror;

window.onerror = function(message, file, line, col, error) {
    z_log_error(message, file, line, col, error);
    if (oldOnError) {
        return oldOnError(message, file, line, col, error);
    } else {
        return false;
    }
};

function z_log_error ( message, file, line, col, error ) {
    if (!z_page_unloading) {
        let payload = {
            type: 'error',
            message: message,
            file: file,
            line: line,
            col: col,
            stack: error ? error.stack : null,
            user_agent: navigator.userAgent,
            url: window.location.href
        };

        let xhr = new XMLHttpRequest();
        xhr.open('POST', '/log-client-event', true);
        xhr.send(JSON.stringify(payload));

        if ($("form.masked").length > 0 || (payload.stack && payload.stack.match(/(submitFunction|doValidations)/))) {
            alert("Sorry, something went wrong.\n\n(" + message + ")");
            try { $("form.masked").unmask(); } catch (e) {}
        }
    }
}


/* Form element validations
----------------------------------------------------------

Grab all "postback" forms, let them be handled by Ajax postback calls.
This function can be run multiple times.

---------------------------------------------------------- */

function z_init_postback_forms()
{
    $("form[action='postback']").each(function() {
        // store options in hash
        $(this).on('click.form-plugin', ":submit,input:image", function(e) {
            var form = this.form;
            form.clk = this;

            if (this.type == 'image')
            {
                if (e.offsetX !== undefined)
                {
                    form.clk_x = e.offsetX;
                    form.clk_y = e.offsetY;
                }
                else if (typeof $.fn.offset == 'function')
                { // try to use dimensions plugin
                    var offset = $(this).offset();
                    form.clk_x = e.pageX - offset.left;
                    form.clk_y = e.pageY - offset.top;
                }
                else
                {
                    form.clk_x = e.pageX - this.offsetLeft;
                    form.clk_y = e.pageY - this.offsetTop;
                }
            }
        });
    })
    .submit(function(event) {
        var theForm = this;

        event.preventDefault();

        z_editor_save(theForm);

        submitFunction = function(ev) {
            try { $(theForm).mask("", 100); } catch (e) {}

            var postback     = $(theForm).data("z_submit_postback");
            var action       = $(theForm).data("z_submit_action");
            var form_id      = $(theForm).attr('id');
            var validations  = $(theForm).formValidationPostback();
            var transport    = '';
            var files        = $('input:file', theForm).fieldValue();
            var is_file_form = false;
            var args;
            
            if (!postback) {
                postback = z_default_form_postback;
            }
            if (action) {
                setTimeout(action, 10);
            }

            for (var j=0; j < files.length && !is_file_form; j++) {
                if (files[j]) {
                    is_file_form = true;
                    break;
                }
            }
            if (is_file_form) {
                transport = 'form';
                args = validations;
            } else {
                if ($(theForm).hasClass("z_cookie_form") ||
                    $(theForm).hasClass("z_logon_form") ||
                    (typeof(z_only_post_forms) != "undefined" && z_only_post_forms)) {
                    transport = 'ajax';
                }
                args = validations.concat($(theForm).formToArray());
            }

            // add submitting element to data if we know it
            var sub = theForm.clk;
            if (sub) {
                var n = sub.name;
                if (n && !sub.disabled) {
                    args.push({name: n, value: $(sub).val()});
                    args.push({name: 'z_submitter', value: n});
                    if (sub.type == "image") {
                        args.push({name: name+'.x', value: theForm.clk_x});
                        args.push({name: name+'.y', value: theForm.clk_y});
                    }
                }
            }

            // Queue the postback, or use a post to an iframe (if files present)
            z_queue_postback(form_id, postback, args, false, transport, theForm);

            theForm.clk   = null;
            theForm.clk_x = null;
            theForm.clk_y = null;
            ev.stopPropagation();
            return false;
        };

        return z_form_submit_validated_delay(theForm, event, submitFunction);
    })
    .attr('action', '#pb-installed');
}

function z_form_submit_validated_delay(theForm, event, submitFunction)
{
    var validations = $(theForm).formValidationPostback();

    if (validations.length > 0 && !event.zIsValidated)
    {
        // There are form validations and they are not done yet.
        if (!event.zAfterValidation)
        {
            event.zAfterValidation = [];
        }
        event.zAfterValidation.push({ func: submitFunction, context: theForm });
        return true;
    }
    else
    {
        // No form validations, or already validated
        return submitFunction.call(theForm, event);
    }
}

function z_form_submit_validated_do(event)
{
    var ret = true;

    if (event.zAfterValidation)
    {
        $.each(event.zAfterValidation, function(){
            ret = typeof this.func == 'function' && this.func.call(this.context, event) && ret;
        });
        event.zAfterValidation.length = 0;
    }
    return ret;
}


function z_transport_form(qmsg)
{
    var options = {
        url:  '/postback',
        type: 'POST',
        dataType: 'text'
    };
    var $form = $(qmsg.options.post_form);
    var form = $form[0];

    if ($(':input[name=submit]', form).length) {
        alert('Error: Form elements must not be named "submit".');
        return;
    }

    var opts = $.extend({}, $.ajaxSettings, options);
    var s = $.extend(true, {}, $.extend(true, {}, $.ajaxSettings), opts);

    var id = 'jqFormIO' + (new Date().getTime());
    var $io = $('<iframe id="' + id + '" name="' + id + '" src="about:blank" />');
    var io = $io[0];

    $io.css({ position: 'absolute', top: '-1000px', left: '-1000px' });

    var xhr = { // mock object
        aborted: 0,
        responseText: null,
        responseXML: null,
        status: 0,
        statusText: 'n/a',
        getAllResponseHeaders: function() {},
        getResponseHeader: function() {},
        setRequestHeader: function() {},
        abort: function() {
            this.aborted = 1;
            $io.attr('src','about:blank'); // abort op in progress
        }
    };

    var g = opts.global;

    // trigger ajax global events so that activity/block indicators work like normal
    if (g && ! $.active++) $.event.trigger("ajaxStart");
    if (g) $.event.trigger("ajaxSend", [xhr, opts]);

    if (s.beforeSend && s.beforeSend(xhr, s) === false) {
        s.global && $.active--;
        return;
    }
    if (xhr.aborted)
        return;

    var cbInvoked = 0;
    var timedOut = 0;

    // take a breath so that pending repaints get some cpu time before the upload starts
    setTimeout(function() {
        // make sure form attrs are set
        var t = $form.attr('target');
        var a = $form.attr('action');

        // update form attrs in IE friendly way
        form.setAttribute('target',id);
        if (form.getAttribute('method') != 'POST')
            form.setAttribute('method', 'POST');
        if (form.getAttribute('action') != opts.url)
            form.setAttribute('action', opts.url);

        // ie borks in some cases when setting encoding
        if (! options.skipEncodingOverride) {
            $form.attr({
                encoding: 'multipart/form-data',
                enctype:  'multipart/form-data'
            });
        }

        // support timout
        if (opts.timeout) {
            setTimeout(function() { timedOut = true; cb(); }, opts.timeout);
        }

        zmsgInput = $('<input />')
                        .attr('type', 'hidden')
                        .attr('name', 'z_msg')
                        .attr('value', ubf.encode(qmsg.msg))
                     .prependTo(form)[0];

        try {
            // add iframe to doc and submit the form
            $io.appendTo('body');
            if (io.attachEvent) {
                io.attachEvent('onload', cb);
            } else {
                io.addEventListener('load', cb, false);
            }
            form.submit();
        }
        finally {
            // reset attrs and remove "extra" input elements
            form.setAttribute('action',a);
            if (t) {
                form.setAttribute('target', t);
            } else {
                $form.removeAttr('target');
            }
            $(zmsgInput).remove();
        }
    }, 10);

    function cb() {
        if (io.detachEvent) {
            io.detachEvent('onload', cb);
        } else {
            io.removeEventListener('load', cb, false);
        }
        if (timedOut) {
            $.event.trigger("ajaxError", [xhr, opts, e]);
            z_unmask_error(form.id);
        } else {
            $.event.trigger("ajaxSuccess", [xhr, opts]);
            z_unmask(form.id);
        }
        if (g) {
            $.event.trigger("ajaxComplete", [xhr, opts]);
            $.event.trigger("ajaxStop");
        }
        if (opts.complete) {
            opts.complete(xhr, ok ? 'success' : 'error');
        }
        z_transport_ensure();
    }
}


// Collect all postback validations from the form elements
$.fn.formValidationPostback = function()
{
    var a = [];
    if(this.length > 0) {
        var form = this[0];
        var els      = form.elements;

        if (!els) return a;

        for(var i=0, max=els.length; i < max; i++)
        {
            var el = els[i];
            var n  = el.name;

            if (n && !el.disabled && !$(el).hasClass("nosubmit"))
            {
                var v = $(el).data("z_postback_validation");
                if (v)
                {
                    a.push({name: "z_v", value: n+":"+v});
                }
            }
        }
    }
    return a;
};

// Initialize a validator for the element #id
function z_init_validator(id, args)
{
    var elt = $('#'+id);
    if (elt)
    {
        if (elt.attr('type') == 'radio')
        {
            $('input[name="'+elt.attr('name')+'"]').each(function() {
                addLiveValidation(this, args);
            });
        }
        else
        {
            addLiveValidation(elt, args);
        }
    }
    else
    {
        $.misc.error('Validator error: no element with id #'+id, $(id));
    }
}

// Add a validator to the input field
function z_add_validator(id, type, args)
{
    var elt = $('#'+id);

    if (elt.attr('type') == 'radio')
        elt = $('input[name="'+elt.attr('name')+'"]');

    elt.each(function() {
        var v = getLiveValidation(this);
        if (v)
        {
            if (args['pattern'])
            {
                args['pattern'] = new RegExp(args['pattern']);
            }
            switch (type)
            {
                case 'email':           v.add(Validate.Email, args);        break;
                case 'date':            v.add(Validate.Date, args);         break;
                case 'presence':        v.add(Validate.Presence, args);     break;
                case 'confirmation':    v.add(Validate.Confirmation, args); break;
                case 'acceptance':      v.add(Validate.Acceptance, args);   break;
                case 'length':          v.add(Validate.Length, args);       break;
                case 'format':          v.add(Validate.Format, args);       break;
                case 'numericality':    v.add(Validate.Numericality, args); break;
                case 'custom':          v.add(Validate.Custom, args);       break;
                case 'postback':
                    args['z_id'] = id;
                    v.add(Validate.Postback, args);
                    break;
                default:
                    $.misc.error("unknown validation: "+type);
                    break;
            }
        }
    });
}

function z_set_validator_postback(id, postback)
{
    if (postback)
    {
        var pb = $('#'+id).data("z_postback_validation");
        if (pb)
        {
            $.misc.error("Element #"+id+" had already a validation postback, add all validations as one batch.", $('#' +id));
        }

        $('#'+id).data("z_postback_validation", postback);
    }
}

function z_validation_on_invalid(id, on_invalid)
{
    $('#'+id).each(function() {
        if (this.tagName.toLowerCase() == 'form')
        {
            var formObj = LiveValidationForm.getInstance(this);
            formObj.onInvalid = on_invalid;
        }
    });
}


function z_async_validation_result(id, isValid, testedValue)
{
    var v = getLiveValidation($('#'+id));
    if (v && $('#'+id).val() == testedValue)
    {
        v.asyncValidationResult(isValid, testedValue);
    }
}

// Called by the server on validation errors
function z_validation_error(id, error)
{
    var v = getLiveValidation($('#'+id));
    if (v)
    {
        if (error == 'invalid')
        {
            // Generic error - handle it ourselves
            error = "please correct";
        }
        v.showErrorMessage(error);
    }
}


// Execute a function by name
function z_call_function_by_name(name, context)
{
    var args = Array.prototype.slice.call(arguments).splice(2);
    var namespaces = name.split(".");
    var func = namespaces.pop();
    for(var i = 0; i < namespaces.length; i++) {
        context = context[namespaces[i]];
    }
    return context[func].apply(this, args);
}

// URL encode function that is more RFC compatible.      Also encodes +, *, / and @.
function urlencode(s)
{
    s = escape(s);
    s = s.replace(/\+/g, '%2B');
    s = s.replace(/\*/g, '%2A');
    s = s.replace(/\//g, '%2F');
    s = s.replace(/@/g, '%40');
    return s;
}

// HTML escape a string so it is safe to concatenate when making tags.
function html_escape(s)
{
    return s.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
}

// HTML unescape a string.
function html_unescape(s)
{
    return s.replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"")
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&");
}


// Convert an object to an array with {name: xxx, value: yyy} pairs
function ensure_name_value(a)
{
    if ((typeof a == 'object') && !(a instanceof Array))
    {
        var n = [];
        for (var prop in a)
        {
            if (a[prop] !== undefined)
                n.push({name: prop, value: a[prop]});
        }
        return n;
    }
    else
    {
        return a;
    }
}

// Update the contents of an iframe
function z_update_iframe(name, doc)
{
    var iframe = window.frames[name];
    if (iframe) {
        var iframe_doc = iframe.document || iframe.contentDocument || iframe.contentWindow.document;
        iframe_doc.open();
        iframe_doc.write(doc);
        iframe_doc.close();
    }
}


// Store the current cookie consent status
function z_cookie_consent_store( status )
{
    if (status !== 'all') {
        z_cookie_remove_all();
    }
    switch (status) {
        case "functional":
        case "stats":
        case "all":
            const prev = z_cookie_consent_cache;
            window.z_cookie_consent_cache = status;
            try {
                // Use stringify to be compatible with model.localStorage
                localStorage.setItem('z_cookie_consent', JSON.stringify(status));
            } catch (e) {
            }
            const ev = new CustomEvent("zotonic:cookie-consent", {
                detail: {
                    cookie_consent: status
                }
            });
            if (prev != status) {
                window.dispatchEvent(ev);
            }
            break;
        default:
            console.error("Cookie consent status must be one of 'all', 'stats' or 'functional'", status);
            break;
    }
}

// Trigger on consent changes in other windows/tabs
window.addEventListener("storage", function(ev) {
    if (ev.key == 'z_cookie_consent') {
        if (ev.newValue === null) {
            window.z_cookie_consent_cache = 'functional';
        } else if (ev.oldValue != ev.newValue) {
            z_cookie_consent_store(ev.newValue);
        }
    }
}, false);


// Fetch the current cookie consent status - default to 'functional'
function z_cookie_consent_fetch()
{
    if (window.z_cookie_consent_cache) {
        return window.z_cookie_consent_cache;
    } else {
        let status;

        try {
            status = localStorage.getItem('z_cookie_consent');
        } catch (e) {
            status = null;
        }

        if (status !== null) {
            status = JSON.parse(status);
        } else {
            status = 'functional';
        }
        window.z_cookie_consent_cache = status
        return status;
    }
}

// Check is the user consented to some cookies
function z_cookie_consent_given()
{
    try {
        return typeof (localStorage.getItem('z_cookie_consent')) === 'string';
    } catch (e) {
        return false;
    }
}


// Check if something is allowed according to the stored consent status
function z_cookie_consented( wanted )
{
    const consent = z_cookie_consent_fetch();

    switch (wanted) {
        case 'functional':
            return true;
        case 'stats':
            return consent === 'all' || consent === 'stats';
        case 'all':
            return consent === 'all';
        default:
            return false;
    }
}

// Remove all non-functional cookies from the current document domain
function z_cookie_remove_all()
{
    for ( const cookie of document.cookie.split(';') ){
        const cookieName = cookie.split('=')[0].trim();

        switch (cookieName) {
            case "z_sid":
            case "z_rldid":
            case "z_ua":
            case "z.sid":
            case "z.lang":
            case "z.auth":
            case "z.autologon":
                // Functional - keep the cookie
                break;
            default:
                // Non-functional - remove the cookie
                let domains = window.location.hostname.split('.');
                while ( domains.length > 0 ) {
                    const domain = domains.join('.');
                    const cookieReset = encodeURIComponent(cookieName) + '=; expires=Thu, 01-Jan-1970 00:00:01 GMT';

                    document.cookie = cookieReset;
                    document.cookie = cookieReset + '; domain=' + domain + ' ;path=/';

                    let pathSegments = location.pathname.split('/');
                    while ( pathSegments.length > 0 ){
                        const path = pathSegments.join('/');
                        document.cookie = cookieReset + '; domain=' + domain + ' ;path=' + path;
                        pathSegments.pop();
                    }
                    domains.shift();
                }
                break;
        }
    }
}

// From: http://malsup.com/jquery/form/jquery.form.js

/*
 * jQuery Form Plugin
 * version: 2.28 (10-MAY-2009)
 * @requires jQuery v1.2.2 or later
 *
 * Examples and documentation at: http://malsup.com/jquery/form/
 * Dual licensed under the MIT and GPL licenses:
 *   http://www.opensource.org/licenses/mit-license.php
 *   http://www.gnu.org/licenses/gpl.html
 */

/**
 * formToArray() gathers form element data into an array of objects that can
 * be passed to any of the following ajax functions: $.get, $.post, or load.
 * Each object in the array has both a 'name' and 'value' property.      An example of
 * an array for a simple login form might be:
 *
 * [ { name: 'username', value: 'jresig' }, { name: 'password', value: 'secret' } ]
 *
 * It is this array that is passed to pre-submit callback functions provided to the
 * ajaxSubmit() and ajaxForm() methods.
 */
$.fn.formToArray = function(options) {
    var a = [];
    options = options || {};
    if (this.length > 0) {
        var form = this[0];
        var els = options.semantic ? form.getElementsByTagName('*') : form.elements;
        var n;

        if (els) {
            for(var i=0, max=els.length; i < max; i++) {
                var el = els[i];
                n = el.name;
                if (n && (!$(el).hasClass("nosubmit") || options.all)) {
                    switch ($(el).attr("type")) {
                        case "submit":
                            break;
                        case "file":
                            break;
                        default:
                            var v = $.fieldValue(el, true);
                            if (v && v.constructor == Array) {
                                for(var j=0, jmax=v.length; j < jmax; j++)
                                    a.push({name: n, value: v[j]});
                            }
                            else if (v !== null && typeof v != 'undefined') {
                                a.push({name: n, value: v});
                            }
                    }
                }
            }
        }
    }
    return a;
};


/**
 * Returns the value(s) of the element in the matched set.  For example, consider the following form:
 *
 *  <form><fieldset>
 *      <input name="A" type="text" />
 *      <input name="A" type="text" />
 *      <input name="B" type="checkbox" value="B1" />
 *      <input name="B" type="checkbox" value="B2"/>
 *      <input name="C" type="radio" value="C1" />
 *      <input name="C" type="radio" value="C2" />
 *  </fieldset></form>
 *
 *  var v = $(':text').fieldValue();
 *  // if no values are entered into the text inputs
 *  v == ['','']
 *  // if values entered into the text inputs are 'foo' and 'bar'
 *  v == ['foo','bar']
 *
 *  var v = $(':checkbox').fieldValue();
 *  // if neither checkbox is checked
 *  v === undefined
 *  // if both checkboxes are checked
 *  v == ['B1', 'B2']
 *
 *  var v = $(':radio').fieldValue();
 *  // if neither radio is checked
 *  v === undefined
 *  // if first radio is checked
 *  v == ['C1']
 *
 * The successful argument controls whether or not the field element must be 'successful'
 * (per http://www.w3.org/TR/html4/interact/forms.html#successful-controls).
 * The default value of the successful argument is true.  If this value is false the value(s)
 * for each element is returned.
 *
 * Note: This method *always* returns an array.      If no valid value can be determined the
 *       array will be empty, otherwise it will contain one or more values.
 */
$.fn.fieldValue = function(successful) {
    for (var val=[], i=0, max=this.length; i < max; i++) {
        var el = this[i];
        var v = $.fieldValue(el, successful);
        if (v === null || typeof v == 'undefined' || (v.constructor == Array && !v.length))
            continue;
        v.constructor == Array ? $.merge(val, v) : val.push(v);
    }
    return val;
};

/**
 * Returns the value of the field element.
 */
$.fieldValue = function(el, successful) {
    var n = el.name, t = el.type, tag = el.tagName.toLowerCase();
    if (typeof successful == 'undefined') successful = true;

    if (successful && (!n || el.disabled || t == 'reset' || t == 'button' ||
        t == 'radio' && !el.checked ||
        (t == 'submit' || t == 'image') && el.form && el.form.clk != el ||
        tag == 'select' && el.selectedIndex == -1))
            return null;

    // Return empty value for non-checked checkboxes
    if (successful && t == 'checkbox' && !el.checked)
        return '';

    if (tag == 'select') {
        var index = el.selectedIndex;
        if (index < 0) return null;
        var a = [], ops = el.options;
        var one = (t == 'select-one');
        var max = (one ? index+1 : ops.length);
        for(var i=(one ? index : 0); i < max; i++) {
            var op = ops[i];
            if (op.selected) {
                var v = op.value;
                if (!v) // extra pain for IE...
                    v = (op.attributes && op.attributes['value'] && !(op.attributes['value'].specified)) ? op.text : op.value;
                if (one) return v;
                a.push(v);
            }
        }
        return a;
    }
    return el.value;
};


/**
 * Clears the form data.  Takes the following actions on the form's input fields:
 *  - input text fields will have their 'value' property set to the empty string
 *  - select elements will have their 'selectedIndex' property set to -1
 *  - checkbox and radio inputs will have their 'checked' property set to false
 *  - inputs of type submit, button, reset, and hidden will *not* be effected
 *  - button elements will *not* be effected
 */
$.fn.clearForm = function() {
    return this.each(function() {
        $('input,select,textarea', this).clearFields();
    });
};

/**
 * Clears the selected form elements.
 */
$.fn.clearFields = $.fn.clearInputs = function() {
    return this.each(function() {
        var t = this.type, tag = this.tagName.toLowerCase();
        if (t == 'text' || t == 'password' || tag == 'textarea')
            this.value = '';
        else if (t == 'checkbox' || t == 'radio')
            this.checked = false;
        else if (tag == 'select')
            this.selectedIndex = -1;
    });
};

/**
 * Resets the form data.  Causes all form elements to be reset to their original value.
 */
$.fn.resetForm = function() {
    return this.each(function() {
        // guard against an input with the name of 'reset'
        // note that IE reports the reset function as an 'object'
        if (typeof this.reset == 'function' || (typeof this.reset == 'object' && !this.reset.nodeType))
            this.reset();
    });
};

/**
 * Enables or disables any matching elements.
 */
$.fn.enable = function(b) {
    if (b === undefined) b = true;
    return this.each(function() {
        this.disabled = !b;
    });
};

/**
 * Checks/unchecks any matching checkboxes or radio buttons and
 * selects/deselects and matching option elements.
 */
$.fn.selected = function(select) {
    if (select === undefined) select = true;
    return this.each(function() {
        var t = this.type;
        if (t == 'checkbox' || t == 'radio')
            this.checked = select;
        else if (this.tagName.toLowerCase() == 'option') {
            var $sel = $(this).parent('select');
            if (select && $sel[0] && $sel[0].type == 'select-one') {
                // deselect all other options
                $sel.find('option').selected(false);
            }
            this.selected = select;
        }
    });
};

// helper fn for console logging
function log() {
    if (window.console && window.console.log)
        window.console.log('[jquery.form] ' + Array.prototype.join.call(arguments,''));
}



function is_equal(x, y) {
    if ( x === y ) return true;
    if ( ! ( x instanceof Object ) || ! ( y instanceof Object ) ) return false;
    if ( x.constructor !== y.constructor ) return false;
    for ( var p in x ) {
        if ( ! x.hasOwnProperty( p ) ) continue;
        if ( ! y.hasOwnProperty( p ) ) return false;
        if ( x[ p ] === y[ p ] ) continue;
        if ( typeof( x[ p ] ) !== "object" ) return false;
        if ( ! is_equal( x[ p ],  y[ p ] ) ) return false;
    }
    for ( p in y ) {
        if ( y.hasOwnProperty( p ) && ! x.hasOwnProperty( p ) ) return false;
    }
    return true;
}

$.extend({
    keys: function(obj){
        if (typeof Object.keys == 'function')
            return Object.keys(obj);
        var a = [];
        $.each(obj, function(k){ a.push(k) });
        return a;
    }
});


/**
 * A simple querystring parser.
 * Example usage: var q = $.parseQuery(); q.fooreturns  "bar" if query contains "?foo=bar"; multiple values are added to an array.
 * Values are unescaped by default and plus signs replaced with spaces, or an alternate processing function can be passed in the params object .
 * http://actingthemaggot.com/jquery
 *
 * Copyright (c) 2008 Michael Manning (http://actingthemaggot.com)
 * Dual licensed under the MIT (MIT-LICENSE.txt)
 * and GPL (GPL-LICENSE.txt) licenses.
 **/
$.parseQuery = function(qs,options) {
    var q = (typeof qs === 'string'?qs:window.location.search), o = {'f':function(v){return unescape(v).replace(/\+/g,' ');}}, options = (typeof qs === 'object' && typeof options === 'undefined')?qs:options, o = jQuery.extend({}, o, options), params = {};
    jQuery.each(q.match(/^\??(.*)$/)[1].split('&'),function(i,p){
        p = p.split('=');
        p[1] = o.f(p[1]);
        params[p[0]] = params[p[0]]?((params[p[0]] instanceof Array)?(params[p[0]].push(p[1]),params[p[0]]):[params[p[0]],p[1]]):p[1];
    });
    return params;
};

/**
 * Patch jQuery.find to return [] on queries for '#'
 * This fixes issue https://github.com/zotonic/zotonic/issues/1934
 */
(function( jQuery, window, undefined ) {
    var oldFind = jQuery.find;

    jQuery.find = function( selector ) {
        if (typeof selector == "string" && selector == '#') {
            if (window.console) {
                window.console.log("Zotonic jQuery patch: returning [] for illegal selector '#'");
            }
            return $([]);
        } else {
            var args = Array.prototype.slice.call( arguments );
            return oldFind.apply( this, args );
        }
    };

    // Copy properties attached to original jQuery.find method (e.g. .attr, .isXML)
    var findProp;
    for ( findProp in oldFind ) {
        if ( Object.prototype.hasOwnProperty.call( oldFind, findProp ) ) {
            jQuery.find[ findProp ] = oldFind[ findProp ];
        }
    }
})( jQuery, window );
/* Admin widgetManager class
----------------------------------------------------------

@package:	Zotonic
@Author:	Tim Benniks <tim@timbenniks.nl>
@Author:	Marc Worrell <marc@worrell.nl>

Copyright 2009-2011 Tim Benniks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---------------------------------------------------------- */

;(function($)
{
    $.extend(
    {
        widgetManager: function(context)
        {
            let stack	= [context || document.body];
            let nodes   = [];

            // 1. Collect nodes
            while (stack.length > 0)
            {
                var defaults;
                var element = stack.pop();

                if (typeof element.className == "string")
                {
                    var objectClass = element.className.match(/do_[a-zA-Z0-9_]+/g);
                    if (objectClass)
                    {
                        var n = objectClass.length;
                        for (var i=0; i<n; i++)
                        {
                            var functionName = objectClass[i].substring(3);
                            var defaultsName = functionName;

                            if ('dialog' == functionName)
                            {
                                functionName = 'show_dialog'; // work around to prevent ui.dialog redefinition
                            }

                            if (typeof $(element)[functionName] == "function")
                            {
                                if ($.ui && $.ui[functionName] && $.ui[functionName].defaults)
                                {
                                    defaults = $.ui[functionName].defaults;
                                }
                                else
                                {
                                    defaults = {}
                                }
                                nodes.push({
                                    element: element,
                                    functionName: functionName,
                                    defaults: defaults,
                                    defaultsName: defaultsName
                                });
                            }
                        }
                    }
                }

                if (element.childNodes)
                {
                    for (var i = 0; i< element.childNodes.length; i++)
                    {
                        if (element.childNodes[i].nodeType != 3)
                        {
                            stack.unshift(element.childNodes[i]);
                        }
                    }
                }
            }

            while (nodes.length > 0)
            {
                let n = nodes.pop();
                $(n.element)[n.functionName]( $.extend({}, n.defaults, $(n.element).metadata(n.defaultsName)) );
            }
        },

        misc:
        {
            log: function(obj)
            {
                var text = obj.toString();
                if(window.console)
                {
                    console.log(text);

                    if($.noticeAdd)
                    {
                        $.noticeAdd({
                            text: 'Logging, check firebug: '+text,
                            type: 'notice',
                            stay: 0
                        });
                    }
                }
                else
                {
                    if($.noticeAdd)
                    {
                        $.noticeAdd({
                            text: 'logged: '+text,
                            type: 'notice',
                            stay: 0
                        });
                    }
                    else
                    {
                        alert(text);
                    }
                }
            },

            warn: function(text, obj)
            {
                obj = obj || '';

                if(window.console)
                {
                    console.warn(text, obj.toString());
                }

                if($.noticeAdd)
                {
                    $.noticeAdd({
                        text: text,
                        type: 'notice',
                        stay: 1
                    });
                }
            },

            error: function(text, obj)
            {
                obj = obj || '';

                if(window.console)
                {
                    console.error(text, obj.toString());
                    if (obj.stack)
                        console.error(obj.stack);
                }

                if($.noticeAdd)
                {
                    $.noticeAdd({
                        text: text,
                        type: 'error',
                        stay: 1
                    });
                }
            }
        }
    });

    $.fn.metadata = function(functionName)
    {
        var elem = this[0];
        var data_name = 'widget-'+functionName;
        var data = $(elem).data(data_name);
        if(typeof data === "undefined")
        {
            data = elem.getAttribute("data-"+functionName);
            if (data)
            {
                if (data.substr(0,1) == "{")
                {
                    try {
                        data = JSON.parse(data);
                    } catch (e) {
                        console.error("Error parsing JSON in widget data attribute:", data);
                        data = {};
                    }
                }
                else
                {
                    try {
                        data = eval("({" + data.replace(/[\n\r]/g,' ') + "})");
                    } catch (e) {
                        console.error("Error evaluating widget data attribute:", data);
                        data = {};
                    }
                }
            }
            else
            {
                data = {};
            }
            $(elem).data(data_name, data);
        }
        return data;
    };

    $.fn.widgetManager = function()
    {
        this.each(function() { $.widgetManager(this); });
        return this;
    };

})(jQuery);
/* UBF(A) encoder/decoder

@package: Channel.me 2013
@Author: MM Zeeman <mmzeeman@xs4all.nl.nl>

Copyright 2013-2014 Maas-Maarten Zeeman

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

*/

;(function(window) {
    var window = window;
    var ubf = {};
    var specs = {};

    ubf.BINARY = 0;
    ubf.CONSTANT = 1;
    ubf.STRING = 2;
    ubf.TUPLE = 3;
    ubf.LIST = 4;
    ubf.OPCODE = 5;

    DecodeStack = function(start) {
        this._stack = start || [];
        this._markers = [];
    };
    DecodeStack.prototype.length = function() {
        return this._stack.length;
    };
    DecodeStack.prototype.push = function(v) {
        this._stack.push(v);
    };
    DecodeStack.prototype.pop = function() {
        return this._stack.pop();
    };
    DecodeStack.prototype.push_offset = function() {
        this._markers.push(this._stack.length);
    };
    DecodeStack.prototype.pop_offset_diff = function() {
        return this._stack.length - this._markers.pop();
    };


    // Make a constant
    function constant(value) {
        var s = new String(value);
        s.ubf_type = ubf.CONSTANT;
        return s;
    }
    ubf.constant = constant;

    // Encode the value as a ubf(a) tuple. 
    function encode_as_tuple(value, spec, buffer) {
        if (value._record) {
            encode_as_record(value, value._record, spec || specs[value._record], buf);
        } else {
            var buf = buffer || [];
            var inner = [];
            var i;
            buf.push('{');
            if (spec) {
                for (i = 0; i<spec.length; i++) {
                    encode(value[spec[i]], inner);
                }
            } else {
                var ks = Object.keys(value);
                for (i = 0; i<ks.length; i++) {
                    encode(value[ks[i]], inner);
                }
            }
            buf.push(inner.join(","));
            buf.push('}');

            if(!buffer) {
                buf.push("$");
                return buf.join("");
            }
        }
    }
    ubf.encode_as_tuple = encode_as_tuple;

    // Encode the value as list
    function encode_as_list(value, buffer) {
        var buf = buffer || [];
        var i;

        buf.push("#");
        for(i=value.length-1; i >= 0; i--) {
            encode(value[i], buf);
            buf.push('&');
        }

        if(!buffer) {
            buf.push("$");
            return buf.join("");
        }
    }
    ubf.encode_as_list = encode_as_list;

    // Encode as proplist with {key,value} tuples.
    function encode_as_proplist(value, buffer) {
        var buf = buffer || [];
        var ks = Object.keys(value);

        buf.push("#");
        for (var i = 0; i<ks.length; i++) {
            var k = ks[i];
            buf.push('{');
            encode(k, buf);
            buf.push(' ');
            encode(value[k], buf);
            buf.push('}&');
        }
        if(!buffer) {
            buf.push("$");
            return buf.join("");
        }
    }
    ubf.encode_as_proplist = encode_as_proplist;

    // Encode as record
    function encode_as_record(value, record_name, spec, buffer) {
        var buf = buffer || [];
        var inner = [];
        var i;
        spec = spec || specs[record_name];

        buf.push('{');
        if(spec) {
            encode_as_constant(record_name, inner);
            for (i = 0; i<spec.length; i++) {
                encode(value[spec[i]], inner);
            }
        } else {
            ks = Object.keys(value);
            for (i = 0; i<ks.length; i++) {
                encode(value[ks[i]], inner);
            }
        }
        buf.push(inner.join(","));
        buf.push('}');

        if(!buffer) {
            buf.push("$");
            return buf.join("");
        }
    }
    ubf.encode_as_record = encode_as_record;

    function string_escape(s) {
        if(s === undefined) return "";
        return s.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
    }

    function constant_escape(s) {
        if(s === undefined) return "";
        return s.replace(/\\/g, "\\\\").replace(/\'/g, "\\'");
    }

    function encode_as_string(value, buffer) {
        buffer.push(['"', string_escape(value), '"'].join(""));
    }
    ubf.encode_as_string = encode_as_string;

    function encode_as_binary(value, buffer) {
        buffer.push(_utf8len(value)+"~"+value+"~");
    }
    ubf.encode_as_binary = encode_as_binary;

    function encode_as_constant(value, buffer) {
        buffer.push(["'", constant_escape(value), "'"].join(""));
    }
    ubf.encode_as_constant = encode_as_constant;

    // ubf(a) encode javascript to ubf.
    //
    function encode(value, buffer) {
        var buf = buffer || [];

        if(value === undefined || value === null) {
            encode_as_constant("undefined", buf);
        } else {
            switch(value.ubf_type) {
            case ubf.STRING:
                encode_as_string(value, buf);
                break;
            case ubf.CONSTANT:
                encode_as_constant(value, buf);
                break;
            case ubf.BINARY:
                encode_as_binary(value, buf);
                break;
            case ubf.LIST:
                encode_as_list(value, buf);
                break;
            case ubf.TUPLE:
                encode_as_tuple(value, undefined, buf);
                break;
            case ubf.OPCODE:
                buf.push(value);
                break;
            default:
                if(typeof value == "object" && value instanceof Array) {
                    encode_as_list(value, buf);
                } else if(typeof(value) == "number") {
                    if (Math.floor(value) == value) {
                        buf.push(Math.floor(value));
                    } else {
                        buf.push('"'+value+'"`f`');
                    }
                } else if(typeof(value) == "string") {
                    // Per default encode strings as binary - better on the server
                    encode_as_binary(value, buf);
                } else if (typeof(value) == "object" && value instanceof Date) {
                    buf.push(""+Math.round(value.getTime() / 1000)+"`dt`");
                } else if (typeof(value) == "object" && value._record) {
                    encode_as_record(value, value._record, specs[value._record], buf);
                } else if(typeof(value) == "object") {
                    var keys = Object.keys(value);
                    if (keys.length == 2 && ('name' in value) && ('value' in value)) {
                        encode_as_tuple([value.name, value.value], undefined, buf);
                    } else {
                        encode_as_proplist(value, buf);
                    }
                } else if(typeof(value) == "object" && value.valueOf) {
                    encode_as_binary(value.valueOf(), buf);
                } else if(typeof(value) == "boolean") {
                    encode_as_constant((value)?"true":"false", buf);
                } else if(value === null) {
                    encode_as_constant("undefined", buf);
                } else {
                    throw("ubf encode: unknown value");
                }
            }
        }

        if(!buffer) {
            buf.push("$");
            return buf.join("");
        }
    }
    ubf.encode = encode;

    // ubf(a) decoder
    //
    // 
    ubf.decode = function(bytes, ready_fun, env, startStack) {
        var j, opcode;

        stack = new DecodeStack(startStack);
        env = env || {};

        try {
            while(true) {
                opcode = bytes.charAt(0);
                j = _operation(opcode, bytes, env, stack);
                if(j === 0) {
                    if(ready_fun) {
                        data = stack.pop();
                        ready_fun(data);
                        bytes = bytes.slice(1);
                        if(bytes.length === 0)
                            return data;
                    } else {
                        return stack.pop();
                    }
                }
                bytes = bytes.slice(j);
            }
        }
        catch(err) {
            console.log(err, stack, bytes);
            throw err;
        }
    };

    /* A spec is a list of field names */
    ubf.add_spec = function(name, spec) {
        specs[name] = spec;
    };

    function _read(bytes, terminator, type, stack) {
        var current, buf = [], i = 0;

        while(true) {
            current = bytes.charAt(i);
            
            if(current === undefined)
                throw "Missing terminator";
            
            if(current == "\\") {
                switch(bytes.charAt(i+1)) {
                    case "\\":
                        buf.push("\\");
                        break;
                    case terminator:
                        buf.push(terminator);
                        break;
                    default:
                        throw "Wrong " + type + " escape sequence";
                }
                i += 2;
                continue;
            }

            if(current == terminator) {
                if(stack) {
                    var obj;
                    var buf_s = buf.join("");
                    if (type == ubf.STRING) {
                        obj = buf_s;
                    } else {
                        if (type == ubf.CONSTANT) {
                            switch (buf_s)
                            {
                                case 'false':     obj = false; break;
                                case 'true':      obj = true; break;
                                case 'undefined': break;
                                default:
                                    obj = buf_s;
                                    break;
                            }
                        } else {
                            obj = buf_s;
                        }
                    }
                    stack.push(obj);
                }
                return i + 1;
            }

            buf.push(current);
            i += 1;
        }
    }

    function skip_ws(bytes) {
        if(!bytes) return 0;
        var ws = bytes.match(/^(\s|,)+/);
        if(ws)
            return ws[0].length;
        return 0;
    }

    function _integer_or_binary_data(bytes, stack) {
        var found = bytes.match(/^\-?[0-9]+/)[0],
            integer = Number(found),
            length = found.length,
            rest = bytes.slice(length),
            ws_length = skip_ws(rest);

        if(rest.charAt(ws_length) != "~") {
            stack.push(integer);
            return length;
        }
        // assume input was utf-8 data, correct for decoded JS utf-16 chars
        var charct = _binarychars(rest, ws_length+1, integer);
        var binary = rest.slice(ws_length + 1, ws_length + charct + 1);
        stack.push(binary);

        if(rest.charAt(ws_length+1+charct) != "~")
            throw "UBF decode: missing closing ~";

        return length + ws_length + charct + 2;
    }

    function _string(bytes, stack) {
        return _read(bytes.slice(1), '"', ubf.STRING, stack) + 1;
    }

    function _constant(bytes, stack) {
        return _read(bytes.slice(1), "'", ubf.CONSTANT, stack) + 1;
    }

    function _start_tuple(stack) {
        stack.push_offset(); // marker for building a tuple
        return 1;
    }

    function _end_tuple(stack) {
        // pop items from the stack until we find NaN
        var tuple = [];
        tuple.ubf_type = ubf.TUPLE;

        var obj;
        var ct = stack.pop_offset_diff();

        if (ct < 0) {
            console.log("UBF decode error - empty stack for tuple", stack);
            throw "UBF decode: Empty stack on tuple";
        }
        while (ct--) {
            obj = stack.pop();
            tuple.unshift(obj);
        }
        if (tuple[0] &&
            typeof tuple[0] == "string" &&
            typeof specs[tuple[0].valueOf()] !== 'undefined')
        {
            var rec_name = tuple[0].valueOf();
            var rec  = { _record: rec_name };
            var spec = specs[rec_name];
            var n    = spec.length;
            if (n in tuple && !((n+1) in tuple)) {
                for (var i=0; i<n; i++) {
                    rec[spec[i]] = tuple[i+1];
                }
                stack.push(rec);
            } else {
                // Length mismatch - leave as tuple
                stack.push(tuple);
            }
        } else {
            stack.push(tuple);
        }
        return 1;
    }

    function _push_nil(stack) {
        var list = [];
        list.ubf_type = ubf.LIST;
        stack.push(list);
        return 1;
    }

    function _push_element(stack) {
        var obj = stack.pop(), list = stack.pop();
        if(list.ubf_type != ubf.LIST) throw "Push error: not a list";
        list.unshift(obj);
        stack.push(list);
        return 1;
    }

    function _comment(bytes) {
        return _read(bytes.slice(1), "%") + 1;
    }

    function _pop(bytes, env, stack) {
        var code = bytes.charAt(1);
        env[code] = stack.pop();
        return 2;
    }

    function _push(bytes, env, stack) {
        var code = bytes.charAt(0);
        if(!env.hasOwnProperty(code))
            throw "Unknown register value: " + code;
        stack.push(env[code]);
        return 1;
    }

    function _return(stack) {
        if(stack.length() == 1)
            return 0;
        throw "The stack should contain one item";
    }

    function _type(bytes, stack) {
        var n = _read(bytes.slice(1), '`', ubf.STRING, stack) + 1;
        switch (stack.pop()) {
            case "map":
            case "plist":
                var list = stack.pop();
                var ks = Object.keys(list);
                var map = {};
                if (list.ubf_type != ubf.LIST) throw "Type error: not a list (for map)";
                for (var i = 0; i<ks.length; i++) {
                    var k = ks[i];
                    if (k != 'ubf_type') {
                        var elt = list[k];
                        if (typeof elt == "object" && 1 in elt) {
                            map[elt[0]] = elt[1];
                        } else {
                            map[elt] = true;
                        }
                    }
                }
                stack.push(map);
                break;
            case "f":
                var f = stack.pop();
                if (typeof f != "string") throw "Type error: not a string (for float)";
                stack.push(parseFloat(f));
                break;
            case "dt":
                var dt = stack.pop();
                if (typeof dt != "number") throw "Type error: not a number (for dt)";
                stack.push(new Date(dt*1000));
                break;
            default:
                break;
        }
        return n;
    }

    function _operation(opcode, bytes, env, stack) {
        switch(opcode) {
        case " ":case "\r":case"\n":case"\t":case",": return skip_ws(bytes);
        case "-":
        case"0":case"1":case"2":case"3":case"4":
        case"5":case"6":case"7":case"8":case"9": return _integer_or_binary_data(bytes, stack);
        case '"': return _string(bytes, stack);
        case "'": return _constant(bytes, stack);
        case "{": return _start_tuple(stack);
        case "}": return _end_tuple(stack);
        case "#": return _push_nil(stack);
        case "&": return _push_element(stack);
        case "%": return _comment(bytes);
        case ">": return _pop(bytes, env, stack);
        case "$": return _return(stack);
        case "`": return _type(bytes, stack);
        default: return _push(bytes, env, stack);
        }
    }

    function _utf8len ( s )
    {
        var n = 0;
        for (var i = 0; i < s.length; i++) {
            var code = s.charCodeAt(i);
            if (code <= 0x7f) n++;
            else if (code <= 0x7ff) n += 2;
            else if (code >= 0xd800 && code <= 0xdfff) {
                n += 4;
                i++;
            }
            else if (code < 0xffff) n += 3;
            else n += 4;
        }
        return n;
    }

    function _binarychars ( s, offset, bytect )
    {
        var i = offset;
        while (bytect > 0)
        {
            var code = s.charCodeAt(i++);
            if (code <= 0x7f) bytect--;
            else if (code <= 0x7ff) bytect -= 2;
            else if (code >= 0xd800 && code <= 0xdfff) {
                bytect -= 4;
                i++;
            }
            else if (code < 0xffff) bytect -= 3;
            else bytect -= 4;
        }
        return i - offset;
    }

    window.ubf = ubf;
})(window);
/* growl notice js
 ----------------------------------------------------------

 @package:      Zotonic 2009    
 @Author:       Tim Benniks <tim@timbenniks.nl>

 Copyright 2009 Tim Benniks

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
 
 http://www.apache.org/licenses/LICENSE-2.0
 
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.

 ---------------------------------------------------------- */

(function(jQuery)
 {
     jQuery.extend(
     {                    
         noticeAdd: function(options)
         {        
             var defaults = {
                 inEffect:                        {opacity: 'show'},      // in effect
                 inEffectDuration:                300,                            // in effect duration in miliseconds
                 stayTime:                        3000,                           // time in miliseconds before the item has to disappear
                 text:                            '',                                     // content of the item
                 stay:                            false,                          // should the notice item stay or not?
                 type:                            'notice'                        // could also be error, succes
             };

             var map = {
                 notice: 'alert-info',
                 error: 'alert-danger'
             };
             
             // declare varaibles
             var options, noticeWrapAll, noticeItemOuter, noticeItemInner, noticeItemClose;
             
             options              = jQuery.extend({}, defaults, options);
             noticeWrapAll        = (!jQuery('.notice-wrap').length) ? jQuery('<div></div>').addClass('notice-wrap').appendTo('body') : jQuery('.notice-wrap');
             noticeItemOuter      = jQuery('<div></div>').addClass('notice-item-wrapper');
             noticeItemInner      = jQuery('<div></div>').hide().addClass('alert  ' + map[options.type]).prependTo(noticeWrapAll).html(options.text).animate(options.inEffect, options.inEffectDuration).wrap(noticeItemOuter);
             noticeItemClose      = jQuery('<a>').addClass('close').prependTo(noticeItemInner).html('<span>&times;</span>').click(function() { jQuery.noticeRemove(noticeItemInner); });
             
             // hmmmz, zucht
             if(navigator.userAgent.match(/MSIE 6/i)) 
             {
                 noticeWrapAll.css({top: document.documentElement.scrollTop});
             }
             
             if(!options.stay)
             {
                 setTimeout(function()
                            {
                                jQuery.noticeRemove(noticeItemInner);
                            },
                            options.stayTime);
             }
         },
         
         noticeRemove: function(obj)
         {
             obj.animate({opacity: '0'}, 600, function()
                         {
                             obj.closest(".notice-item-wrapper").animate({height: '0px'}, 300, function()
                                                  {
                                                      obj.closest(".notice-item-wrapper").remove();
                                                  });
                         });
         }
     });
 })(jQuery);
/* imageviewer js
----------------------------------------------------------

@package:	Zotonic 2009	
@Author: 	Tim Benniks <tim@timbenniks.nl>

Copyright 2009 Tim Benniks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
 
http://www.apache.org/licenses/LICENSE-2.0
 
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---------------------------------------------------------- */

$.widget("ui.imageviewer", 
{
	_init: function() 
	{ 
		this.init();
		var imageWrapper, imageMagnifier, bigImg;
	},
	
	init: function()
	{
		var ui			= this;
		imageWrapper 	= jQuery('<div></div>').addClass('image-wrapper');
		imageMagnifier 	= jQuery('<div></div>').addClass('image-magnifier').css({top: this.element.offset().top, left: this.element.offset().left});
		bigImg			= jQuery('<img alt="'+ui.element.attr('alt')+'" />').hide();
		
		this.element.wrap(imageWrapper).after(imageMagnifier).parent().hover(function()
		{
			$('.image-magnifier', $(this).parent()).show(150);
		},
		function()
		{
			$('.image-magnifier', $(this).parent()).hide(150);
		});
		
		imageMagnifier.after(bigImg).click(function()
		{
			ui.loadImage()
		});
	},
	
	loadImage: function()
	{
		var ui 				= this;
		var imageOrigSrc 	= ui.element.attr('src').split('.');
		var imageTempSrc 	= imageOrigSrc[0].split('/image/');
		var imageExt		= imageOrigSrc[imageOrigSrc.length - 1];
		var imageSrc 		= '/media/inline/' + imageTempSrc[imageTempSrc.length - 1] + '.' + imageExt;
		var bigImg 			= ui.element.siblings('img');
		
		var loader			= $('<span></span>').css({background: '#fff url(lib/images/spinner.gif) 50% 50% no-repeat', opacity: .5, width: ui.element.width(), height: ui.element.height(), position: "absolute", top: ui.element.offset().top, left: ui.element.offset().left})
		
		if(!$('.loaded-bigImage', ui.element.parent()).length)
		{
			$(document.body).append(loader);
		}
		
		$(bigImg)
			.load(function()
			{
				$(this)
					.hide()
					.addClass('loaded-bigImage')
					.unbind('load');

				if(!$('.loaded-bigImage', ui.element.parent()).length)
				{
					ui.element.after($(this));
				}
				
				loader.remove();
				ui.setWidthHeight();
				ui.showBig();
			})
			.attr({src: imageSrc});
	},
	
	setWidthHeight: function()
	{
		$('.loaded-bigImage', this.element.parent())
			.attr({
				width: jQuery('.loaded-bigImage', this.element.parent()).width(),
				height: jQuery('.loaded-bigImage', this.element.parent()).height() 
			});
	},
	
	showBig: function()
	{
		var ui 				= this;
		var imgObj			= jQuery('.loaded-bigImage', ui.element.parent());
		var imgWrapper		= ui.element.parent();
		var zoomImgWidth 	= imgObj.attr('width');
		var zoomImgHeight 	= imgObj.attr('height');
		var fullWidth 		= zoomImgWidth;
		var fullHeight 		= zoomImgHeight;

		if(zoomImgWidth > $(window).width())
		{
			fullWidth = $(window).width() - 40;
			fullHeight = zoomImgHeight * (fullWidth / zoomImgWidth);
		}
		
		if(zoomImgHeight > $(window).height())
		{
			fullHeight = $(window).height() - 40;
			fullWidth = zoomImgWidth * (fullHeight / zoomImgHeight);
		}

		leftPos = ($(window).width() / 2) - (fullWidth / 2);
		topPos 	= $(window).scrollTop() + ($(window).height() / 2) - (fullHeight / 2);

		$(window).resize(function()
		{
			$('.image-magnifier', ui.element.parent()).each(function()
			{
				$(this).css({top: $(this).parent().offset().top, left: $(this).parent().offset().left});
			});
		});
		
		if(!$('.popup-overlay').length)
		{
			$('<span</span>')
				.addClass('popup-overlay')
				.appendTo(document.body)
				.css({display: 'none', height: $(document).height(), zIndex: 8000})
				.animate({opacity: .7}, 200)
				.click(function()
				{
					ui.kill()
				});
		}
		
		$('.popup-overlay').show();
				
		imgObj
			.css({display: 'none', position: "absolute", zIndex: 9999, width: fullWidth, height: fullHeight, left: leftPos, top: topPos})
			.fadeIn(200)
			.click(function()
			{
				ui.kill()
			});
	},
	
	kill: function() 
	{
		jQuery('.popup-overlay').fadeOut(200);
		jQuery('.loaded-bigImage').fadeOut(200);
	   	this.destroy();
	}
});/* dialog js
 ----------------------------------------------------------

 @package:      Zotonic 2009, 2012, 2015
 @Author:       Tim Benniks <tim@timbenniks.nl>

 Copyright 2009 Tim Benniks
 Copyright 2012 Arjan Scherpenisse
 Copyright 2015, 2016 Arthur Clemens

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.

 ---------------------------------------------------------- */

(function($) {
    $.extend({
        dialogAdd: function(options) {
            var width,
                $title,
                $body,
                $text,
                $modalContent,
                dialogClass,
                $modalDialog,
                $dialog;

            $('#zmodal').remove();
            $('.modal-backdrop').remove();

            options = $.extend({}, $.ui.dialog.defaults, options);

            if (options.backdrop !== 'static') {
              $title = $('<div>')
                .addClass('modal-header')
                .append($('<a>')
                .addClass('close')
                .attr('data-dismiss', 'modal')
                .html('<span>&times;</span>'))
                .append($('<h4>')
                .addClass('modal-title')
                .html(options.title));
            } else {
              $title = $('<div>')
                .addClass('modal-header')
                .append($('<h4>')
                .addClass('modal-title')
                .html(options.title));
            }
            $modalContent = $('<div>').addClass('modal-content');
            $text = $('<div>').html(options.text);

            // if .modal-body is used in a template, don't add it again
            if ($text.hasClass('modal-body')) {
                $body = $text;
            } else {
                $body = $('<div>')
                  .addClass('modal-body')
                  .html(options.text);
            }

            $modalContent = $('<div>')
              .addClass('modal-content')
              .append($title)
              .append($body);

            dialogClass = 'modal';
            if (typeof(options.addclass) == 'string') {
                dialogClass += ' ' + options.addclass;
            }

            $modalDialog = $('<div>')
              .addClass('modal-dialog')
              .append($modalContent);

            width = options.width;
            if (width) {
                if (width === 'large') {
                    $modalDialog.addClass('modal-lg');
                } else if (width === 'small') {
                    $modalDialog.addClass('modal-sm');
                } else {
                    $modalDialog.css({'width': width + 'px'});
                }
            }

            $dialog = $('<div>')
              .attr('id', 'zmodal')
              .addClass(dialogClass)
              .append($modalDialog)
              .appendTo($('body'));

            $dialog
              .modal({backdrop: options.backdrop})
              .css({'overflow-x': 'hidden', 'overflow-y': 'auto'});


            if (options.center) {
                $modalDialog.hide();
                setTimeout(function() {
                    // $.dialogCenter();
                    $modalDialog.show();
                }, 0);
            }

            if (typeof($.widgetManager) != 'undefined') {
                $dialog.widgetManager();
            }
            z_editor_add($dialog);
        },

        dialogClose: function() {
            $('#zmodal').modal('hide');
        },

        dialogRemove: function(obj) {
            obj = obj || $('#zmodal');
            z_editor_remove(obj);
            obj
              .draggable('destroy')
              .resizable('destroy')
              .fadeOut(300, function() {
                  $(this).remove();
              });
        },

        dialogCenter: function() {
            var $dialog,
                newMarginTop;
            $dialog = $('#zmodal:visible').find('.modal-dialog');
            newMarginTop = Math.max(0, ($(window).height() - $dialog.height()) / 2);
            newMarginTop *= .96; // visual coherence
            newMarginTop = Math.max(newMarginTop, 30);
            $dialog.css('margin-top', newMarginTop);
        },

        dialogScrollTo: function(position) {
            position = position || 0;
            $("#zmodal")[0].scrollTop = position
        }
    });

    // $(window).on('resize', function() {
    //     $.dialogCenter();
    // });

    $.widget('ui.show_dialog', {
        _init: function() {
            var self = this;
            this.element.click(function() {
                $.dialogAdd({
                    title: self.options.title,
                    text: self.options.text,
                    width: self.options.width,
                    addclass: self.options.addclass,
                    backdrop: self.options.backdrop
                });
            });
        }
    });

    /*
    Default dialog parameters:
    title: text, will be inserted in h4
    text: text content, may contain html (will be inserted into div)
    width: (optional)
    addclass: (optional) classname will be appended to default dialog class
    backdrop: (optional) boolean (0, 1) or the string 'static'
    center: (optional) boolean (0, 1); set to 0 to align dialog to the top
    */
    $.ui.dialog.defaults = {
        title: 'Title',
        text: 'text',
        width: undefined,
        addclass: undefined,
        backdrop: 1,
        center: 1
    };
})(jQuery);
// LiveValidation 1.3 (standalone version)
// Copyright (c) 2007-2008 Alec Hill (www.livevalidation.com)
// LiveValidation is licensed under the terms of the MIT License

// MW: 20100316: Adapted for async usage with Zotonic.
// MW: 20100629: Added support for presence check on radio buttons
// MW: 20110329: Dynamically fetch the validation fields from the DOM, this makes it possible to add/remove fields dynamically.
// AC: 20150129: Removed unused class names. Changed messageClass to Bootstrap 3 conform "help-block". Replaced hardcoded "control-group" to fieldGroupClass, using Bootstrap 3 "form-group". Replaced hardcoded class "success" in favor of fieldGroupSuccessClass (Bootstrap 3 "has-success"); replaced hardcoded class "error" in favor of fieldGroupErrorClass (Bootstrap 3 "has-error").


/*********************************************** LiveValidation class ***********************************/


function addLiveValidation(element, args) {
    if (!$(element).data("z_live_validation"))
        $(element).data("z_live_validation", new LiveValidation($(element).attr('id'), args));
}


function getLiveValidation(element) {
    return $(element).data("z_live_validation");
}


/**
 *  validates a form field in real-time based on validations you assign to it
 *  
 *  @var element {mixed} - either a dom element reference or the string id of the element to validate
 *  @var optionsObj {Object} - general options, see below for details
 *
 *  optionsObj properties:
 *              validMessage {String}   - the message to show when the field passes validation
 *                            (DEFAULT: "Thankyou!")
 *              onAsync {Function}    - function to execute when field passes is waiting for async validation
 *                            (DEFAULT: function(){ this.insertMessage(this.createSpinnerSpan()); this.addFieldClass(); } ) 
 *              onValid {Function}    - function to execute when field passes validation
 *                            (DEFAULT: function(){ this.insertMessage(this.createMessageSpan()); this.addFieldClass(); } ) 
 *              onInvalid {Function}  - function to execute when field fails validation
 *                            (DEFAULT: function(){ this.insertMessage(this.createMessageSpan()); this.addFieldClass(); })
 *              insertAfterWhatNode {Int}   - position to insert default message
 *                            (DEFAULT: the field that is being validated)  
 *              onlyOnBlur {Boolean} - whether you want it to validate as you type or only on blur
 *                            (DEFAULT: false)
 *              wait {Integer} - the time you want it to pause from the last keystroke before it validates (ms)
 *                            (DEFAULT: 0)
 *              onlyOnSubmit {Boolean} - whether should be validated only when the form it belongs to is submitted
 *                            (DEFAULT: false)            
 */

var LiveValidation = function(element, optionsObj){
    this.initialize(element, optionsObj);
};

LiveValidation.VERSION = '1.3 standalone-zotonic';

/** element types constants ****/

LiveValidation.TEXTAREA = 1;
LiveValidation.TEXT     = 2;
LiveValidation.PASSWORD = 3;
LiveValidation.CHECKBOX = 4;
LiveValidation.SELECT   = 5;
LiveValidation.FILE     = 6;
LiveValidation.RADIO    = 7;
LiveValidation.FORM     = 8;


/****** prototype ******/

LiveValidation.prototype = {

    validClass: '', // was: z_valid
    invalidClass: 'z_invalid', // used ny mod_survey
    messageClass: 'z_validation help-block',
    validFieldClass: '', // was: z_valid_field
    invalidFieldClass: '', // was: form-field-error
    asyncFieldClass: '', // was: z_async_validation
    fieldGroupClass: 'form-group',
    fieldGroupErrorClass: 'has-error',
    fieldGroupSuccessClass: 'has-success',

    /**
     *  initialises all of the properties and events
     *
     * @var - Same as constructor above
     */
    initialize: function(element, optionsObj){
      var self = this;
      var $form;

      if(!element)
        throw new Error("LiveValidation::initialize - No element reference or element id has been provided!");
      this.element = element.nodeName ? element : document.getElementById(element);
      if(!this.element)
        throw new Error("LiveValidation::initialize - No element with reference or id of '" + element + "' exists!");
      // default properties that could not be initialised above
      this.validations = [];
      this.elementType = this.getElementType();
      var options = optionsObj || {};
      if (this.elementType == LiveValidation.FORM) {
          this.form = this.element;
          $form = $(this.element);
          this.onAsync = options.onAsync || function(){};
          this.onValid = options.onValid || function(){};
          this.onInvalid = options.onInvalid || function(){};
          this.onlyOnBlur =  options.onlyOnBlur || false;
          this.wait = options.wait || 0;
          this.onlyOnSubmit = true;
      } else {
          this.form = this.element.form;
          $form = $(this.element).closest("form");
          this.onAsync = options.onAsync || function(){ this.insertSpinner(this.createSpinnerSpan()); this.addFieldClass(); };
          this.onValid = options.onValid || function(){ this.insertMessage(this.createMessageSpan()); this.addFieldClass(); };
          this.onInvalid = options.onInvalid || function(){ this.insertMessage(this.createMessageSpan()); this.addFieldClass(); };
          this.onlyOnBlur =  options.onlyOnBlur || false;
          this.wait = options.wait || 0;
          this.onlyOnSubmit = options.onlyOnSubmit || false;
      }
      // options
      this.validMessage = options.validMessage || '';
      var node = options.insertAfterWhatNode || this.element;
      this.insertAfterWhatNode = node.nodeType ? node : document.getElementById(node);
      
      //if document.getElementById(node) returned null, then set the original element
      if(!this.insertAfterWhatNode) 
          this.insertAfterWhatNode = this.element;
        
      this.validationAsync = false;
      
      // Initialize the form hooks, remember the LiveValidationForm object.
      if($form.length){
        this.formObj = LiveValidationForm.getInstance($form[0]);
      }

      // events
      // collect old events
      if (this.elementType != LiveValidation.FORM) {
          this.oldOnFocus = this.element.onfocus || function(){};
          this.oldOnBlur = this.element.onblur || function(){};
          this.oldOnClick = this.element.onclick || function(){};
          this.oldOnChange = this.element.onchange || function(){};
          this.oldOnKeyup = this.element.onkeyup || function(){};
          this.element.onfocus = function(e){ self.doOnFocus(e); return self.oldOnFocus.call(this, e); };
          if(!this.onlyOnSubmit){
            switch(this.elementType){
              case LiveValidation.RADIO:
              case LiveValidation.CHECKBOX:
                this.element.onclick = function(e){ self.validate(); return self.oldOnClick.call(this, e); };
                this.element.onchange = function(e){ self.validate(); return self.oldOnChange.call(this, e); };
                break;
              case LiveValidation.SELECT:
              case LiveValidation.FILE:
                this.element.onchange = function(e){ self.validate(); return self.oldOnChange.call(this, e); };
                break;
              default:
                if(!this.onlyOnBlur) this.element.onkeyup = function(e){ self.deferValidation(); return self.oldOnKeyup.call(this, e); };
                this.element.onblur = function(e){ self.doOnBlur(e); return self.oldOnBlur.call(this, e); };
                break;
            }
          }
      }
    },
  
    /**
     *  destroys the instance's events (restoring previous ones) and removes it from any LiveValidationForms
     */
    destroy: function(){
        // remove events - set them back to the previous events
        if (this.elementType != LiveValidation.FORM) {
            this.element.onfocus = this.oldOnFocus;
            if(!this.onlyOnSubmit){
                switch(this.elementType){
                  case LiveValidation.RADIO:
                  case LiveValidation.CHECKBOX:
                    this.element.onclick = this.oldOnClick;
                    this.element.onchange = this.oldOnChange;
                    break;
                  case LiveValidation.SELECT:
                  case LiveValidation.FILE:
                    this.element.onchange = this.oldOnChange;
                    break;
                  default:
                    if(!this.onlyOnBlur) this.element.onkeyup = this.oldOnKeyup;
                    this.element.onblur = this.oldOnBlur;
                    break;
                }
            }
        }
        this.validations = [];
        this.removeMessageAndFieldClass();
    },
    
    /**
     * Adds a validation to perform to a LiveValidation object
     *
     * @var validationFunction {Function} - validation function to be used (ie Validate.Presence )
     * @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     * @return {Object} - the LiveValidation object itself so that calls can be chained
     */
    add: function(validationFunction, validationParamsObj){
      this.validations.push( {type: validationFunction, params: validationParamsObj || {} } );
      return this;
    },
    
    /**
     * Removes a validation from a LiveValidation object - must have exactly the same arguments as used to add it 
     *
     * @var validationFunction {Function} - validation function to be used (ie Validate.Presence )
     * @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     * @return {Object} - the LiveValidation object itself so that calls can be chained
     */
    remove: function(validationFunction, validationParamsObj){
        var found = false;
        for( var i = 0, len = this.validations.length; i < len; i++ ){
            if( this.validations[i].type == validationFunction ){
                if (this.validations[i].params == validationParamsObj) {
                  found = true;
                  break;
                }
            }
        }
        if(found) this.validations.splice(i,1);
        return this;
    },
    
  
    /**
     * makes the validation wait the alotted time from the last keystroke 
     */
    deferValidation: function(e){
      if (this.wait >= 300)
          this.removeMessageAndFieldClass();
      if (this.timeout)
          clearTimeout(this.timeout);
      var self = this;
      this.timeout = setTimeout( function(){ self.validate(); }, this.wait);
    },
        
    /**
     * sets the focused flag to false when field loses focus 
     */
    doOnBlur: function(e){
      this.focused = false;
      this.validate();
    },
        
    /**
     * sets the focused flag to true when field gains focus 
     */
    doOnFocus: function(e){
      this.focused = true;
      this.removeMessageAndFieldClass();
    },
    
    /**
     *  gets the type of element, to check whether it is compatible
     *
     *  @var validationFunction {Function} - validation function to be used (ie Validate.Presence )
     *  @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     */
    getElementType: function(){
        var nodeName = this.element.nodeName.toUpperCase();
        if (nodeName == 'TEXTAREA')
            return LiveValidation.TEXTAREA;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'TEXT')
            return LiveValidation.TEXT;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'PASSWORD')
            return LiveValidation.PASSWORD;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'CHECKBOX')
            return LiveValidation.CHECKBOX;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'FILE')
            return LiveValidation.FILE;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'RADIO')
            return LiveValidation.RADIO;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'EMAIL')
            return LiveValidation.TEXT;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'TEL')
            return LiveValidation.TEXT;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'NUMBER')
            return LiveValidation.TEXT;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'URL')
            return LiveValidation.TEXT;
        if (nodeName == 'INPUT' && this.element.type.toUpperCase() == 'HIDDEN')
            return LiveValidation.TEXT;
        if (nodeName == 'SELECT')
            return LiveValidation.SELECT;
        if (nodeName == 'FORM')
            return LiveValidation.FORM;
        if (nodeName == 'INPUT')
            throw new Error('LiveValidation::getElementType - Cannot use LiveValidation on an ' + this.element.type + ' input!');
        throw new Error('LiveValidation::getElementType - Element must be an input, select, or textarea!');
    },
    
    /**
     * Loops through all the validations added to the LiveValidation object and checks them one by one
     *
     * @var validationFunction {Function} - validation function to be used (ie Validate.Presence )
     * @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     * @return {Boolean} - whether the all the validations passed or if one failed
     */
    doValidations: function(isSubmit, submitTrigger){
        var result = true;

        this.validationFailed = false;
        this.validationAsync = false;
        for(var i = 0, len = this.validations.length; i < len; ++i){
            var validation = this.validations[i];
            switch(validation.type){
                case Validate.Presence:
                case Validate.Confirmation:
                case Validate.Acceptance:
                case Validate.Custom:
                  this.displayMessageWhenEmpty = true;
                  break;
                default:
                  break;
            }
            var v = this.validateElement(validation.type, validation.params, isSubmit, submitTrigger);
            if (v === 'async') {
                this.validationAsync = true;
                result = 'async';
            } else if (!v) {
                this.validationFailed = true;
                return false;
            }
        }
        this.message = this.validMessage;
        return result;
    },

    /**
     * Check if there is an async validation.
     */
    isAsync: function (){
        for(var i = 0, len = this.validations.length; i < len; ++i) {
            var validation = this.validations[i];
            if (validation.type == Validate.Postback || validation.params.isAsync === true)
                return true;
        }
        return false;
    },
    
    /**
     * Performs validation on the element and handles any error (validation or otherwise) it throws up
     *
     * @var validationFunction {Function} - validation function to be used (ie Validate.Presence )
     * @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     * @var isSubmit {Boolean} - is this a form submit or an individual field check
     * @var submitTrigger {Object} - the element that triggered the submit
     * @return {Boolean} or {"async"} - whether the validation has passed, failed or waits for an async server side check
     */
    validateElement: function(validationFunction, validationParamsObj, isSubmit, submitTrigger){
        if (!this.element.disabled) {
            var value = this.getValue();
            if(validationFunction == Validate.Acceptance){
                if(this.elementType != LiveValidation.CHECKBOX)
                    throw new Error('LiveValidation::validateElement - Element to validate acceptance must be a checkbox!');
                value = this.element.checked;
            }
            var isValid = true;
            try {
                isValid = validationFunction(value, validationParamsObj, isSubmit, submitTrigger);
                if (isValid === 'async') {
                    this.validationAsync = true;
                }
            }
            catch(error) {
                if(error instanceof Validate.Error){
                    if( value !== '' || (value === '' && this.displayMessageWhenEmpty) ){
                        this.validationFailed = true;
                        this.message = error.message;
                        isValid = false;
                    }
                } else {
                    throw error;
                }
            }
            return isValid;
        } else {
            return true;
        }
    },
    
    
    getValue: function() {
        switch (this.elementType) {
        case LiveValidation.SELECT:
            if (this.element.selectedIndex >= 0) return this.element.options[this.element.selectedIndex].value;
            else return "";
        case LiveValidation.RADIO:
            return $('input[name="'+this.element.name+'"]:checked').val();
        case LiveValidation.CHECKBOX:
            var val = [];
            $('input[name="'+this.element.name+'"]:checked').each(function() { val.push($(this).val()); });
            if (val.length === 0) {
                return undefined;
            } else {
                return val;
            }
        case LiveValidation.FORM:
            return "";
        default:
            return this.element.value;
        }
    },

    /**
     * Do all the validations and fires off the onValid or onInvalid callbacks
     *
     * @var isSubmit {Boolean} - is this a form submit or an individual field check
     * @var submitTrigger {Object} - the element that triggered the submit
     * @return {Boolean} or "async" - whether all the validations passed or if one failed
     */
    validate: function(isSubmit, submitTrigger){
        if(!this.element.disabled) {
            var valid = this.doValidations(isSubmit, submitTrigger);
            if (valid === 'async') {
                this.onAsync();
                return 'async';
            } else if (valid) {
                this.onValid();
                return true;
            } else {
                this.onInvalid();
                return false;
            }
        } else {
            return true;
        }
    },
  
    /**
     * Called when there is an async validation result.
     * The caller has already checked if the current input value hasn't changed.
     */
    asyncValidationResult: function(isValid){
        if (this.validationAsync){
            // Find which validation was waiting for async, assume only one async postback per field.
            for(var i = 0, len = this.validations.length; i < len; ++i){
                var validation = this.validations[i];
                if(validation.type == Validate.Postback || validation.params.isAsync === true) {
                    // Clear the async wait flag
                    this.validationAsync = false;
                    this.validationFailed = !isValid;
                    if (isValid){
                        this.onValid();
                    } else {
                        this.onInvalid();
                    }
                    this.formObj.asyncResult(this, isValid);
                }
            }
        }
    },
    
    /**
     *  enables the field
     *
     *  @return {LiveValidation} - the LiveValidation object for chaining
     */
    enable: function(){
        this.element.disabled = false;
        return this;
    },

    /**
     *  disables the field and removes any message and styles associated with the field
     *
     *  @return {LiveValidation} - the LiveValidation object for chaining
     */
    disable: function(){
        this.element.disabled = true;
        this.removeMessageAndFieldClass();
        return this;
    },
    
    /** Message insertion methods ****************************
     * 
     * These are only used in the onValid and onInvalid callback functions and so if you overide the default callbacks,
     * you must either impliment your own functions to do whatever you want, or call some of these from them if you 
     * want to keep some of the functionality
     */
 
     /**
      *  makes a span containing a spinner image
      *
      * @return {HTMLSpanObject} - a span element with the message in it
      */
     createSpinnerSpan: function(){
         var span = document.createElement('span');
         span.innerHTML = '<img src="lib/images/spinner.gif" height="16" width="16" alt="Validating..." />';
         return span;
     },
   
    /**
     *  makes a span containg the passed or failed message
     *
     * @return {HTMLSpanObject} - a span element with the message in it
     */
    createMessageSpan: function(){
        if (!this.message) return null;
        var span = document.createElement('span');
        var textNode = document.createTextNode(this.message);
        span.appendChild(textNode);
        return span;
    },
    
    /**
     * Show an error message
     */
    showErrorMessage: function(message){
        this.message = message;
        this.onInvalid();
    },
    
    /** 
     * Insert a spinner in the message element.
     */
    insertSpinner: function (elementToInsert){
        this.removeMessage();
        if( (this.displayMessageWhenEmpty && (this.elementType == LiveValidation.CHECKBOX || this.element.value === ''))
          || this.element.value !== '' ){

          elementToInsert.className += ' ' + this.messageClass + ' ' + this.asyncFieldClass;
          if(this.insertAfterWhatNode.nextSibling){
              this.insertAfterWhatNode.parentNode.insertBefore(elementToInsert, this.insertAfterWhatNode.nextSibling);
          }else{
              this.insertAfterWhatNode.parentNode.appendChild(elementToInsert);
          }
        }
        
    },
    
    /**
     *  inserts the element containing the message in place of the element that already exists (if it does)
     *
     * @var elementToIsert {HTMLElementObject} - an element node to insert
     */
    insertMessage: function(elementToInsert){
        this.removeMessage();
        if (elementToInsert) {
          if( (this.displayMessageWhenEmpty && (this.elementType == LiveValidation.CHECKBOX || this.element.value === ''))
            || this.element.value !== '' ) {
                  
              var className = this.validationFailed ? this.invalidClass : this.validClass;
              elementToInsert.className += ' ' + this.messageClass + ' ' + className;
              if(this.insertAfterWhatNode.nextSibling){
                  this.insertAfterWhatNode.parentNode.insertBefore(elementToInsert, this.insertAfterWhatNode.nextSibling);
              }else{
                  this.insertAfterWhatNode.parentNode.appendChild(elementToInsert);
              }
          }
        }
    },
    
    
    /**
     *  changes the class of the field based on whether it is valid or not
     */
    addFieldClass: function(){
        this.removeFieldClass();
        if(!this.validationFailed){
            if(this.displayMessageWhenEmpty || this.element.value !== ''){
                $('input[name="'+this.element.name+'"],select[name="'+this.element.name+'"],textarea[name="'+this.element.name+'"]')
                    .closest('.' + this.fieldGroupClass).addClass(this.fieldGroupSuccessClass);
                switch (this.elementType) {
                case LiveValidation.RADIO:
                case LiveValidation.CHECKBOX:
                    $('input[name="'+this.element.name+'"]').closest('label').addClass(this.validFieldClass);
                    break;
                case LiveValidation.FORM:
                    break;
                default:
                    $(this.element).addClass(this.validFieldClass);
                    break;
                }
            }
        }else{
            $('input[name="'+this.element.name+'"],select[name="'+this.element.name+'"],textarea[name="'+this.element.name+'"]')
                    .closest('.' + this.fieldGroupClass).removeClass(this.fieldGroupSuccessClass).addClass(this.fieldGroupErrorClass);
            $('label[for="'+this.element.id+'"]').addClass(this.invalidFieldClass);

            switch (this.elementType) {
            case LiveValidation.RADIO:
            case LiveValidation.CHECKBOX:
                $('input[name="'+this.element.name+'"]').closest('label').addClass(this.invalidFieldClass);
                break;
            case LiveValidation.FORM:
                break;
            default:
                $(this.element).addClass(this.invalidFieldClass);
                break;
            }
        }
    },
    
    /**
     *  removes the message element if it exists, so that the new message will replace it
     */
    removeMessage: function(){
      var nextEl;
      var el = this.insertAfterWhatNode;
      while(el.nextSibling){
          if(el.nextSibling.nodeType === 1){
            nextEl = el.nextSibling;
            break;
        }
        el = el.nextSibling;
      }
      if(nextEl && nextEl.className.indexOf(this.messageClass) != -1)
        this.insertAfterWhatNode.parentNode.removeChild(nextEl);
    },
    
    /**
     *  removes the class that has been applied to the field to indicate if valid or not
     */
    removeFieldClass: function(){
        $('input[name="'+this.element.name+'"],select[name="'+this.element.name+'"],textarea[name="'+this.element.name+'"]')
                .closest('.' + this.fieldGroupClass).removeClass(this.fieldGroupSuccessClass).removeClass(this.fieldGroupErrorClass);
        $('label[for="'+this.element.id+'"]').removeClass(this.invalidFieldClass);
        switch (this.elementType) {
        case LiveValidation.RADIO:
        case LiveValidation.CHECKBOX:
            $('input[name="'+this.element.name+'"]').closest('label').removeClass(this.invalidFieldClass).removeClass(this.validFieldClass);
            break;
        case LiveValidation.FORM:
            break;
        default:
            $(this.element).removeClass(this.invalidFieldClass).removeClass(this.validFieldClass);
            break;
        }
    },
        
    /**
     *  removes the message and the field class
     */
    removeMessageAndFieldClass: function(){
      this.removeMessage();
      this.removeFieldClass();
    }

}; // end of LiveValidation class




/*************************************** LiveValidationForm class ****************************************/
/**
 * This class is used internally by LiveValidation class to associate a LiveValidation field with a form it is icontained in one
 * 
 * It will therefore not really ever be needed to be used directly by the developer, unless they want to associate a LiveValidation 
 * field with a form that it is not a child of
 */

/**
   *  handles validation of LiveValidation fields belonging to this form on its submittal
   *  
   *  @var element {HTMLFormElement} - a dom element reference to the form to turn into a LiveValidationForm
   */
var LiveValidationForm = function(element){
  this.initialize(element);
};

/**
   *  gets the instance of the LiveValidationForm if it has already been made or creates it if it doesnt exist
   *  
   *  @var element {HTMLFormElement} - a dom element reference to a form
   */
LiveValidationForm.getInstance = function(element){
  var rand = Math.random() * Math.random();
  if(!$(element).attr("id"))
    $(element).attr("id", 'formId_' + rand.toString().replace(/\./, '') + new Date().valueOf());
  var instance = $(element).data("z_live_validation_instance");
  if (!instance) {
      instance = new LiveValidationForm(element);
      $(element).data("z_live_validation_instance", instance);
  }
  return instance;
};

LiveValidationForm.prototype = {
  validFormClass: 'z_form_valid',
  invalidFormClass: 'z_form_invalid',

  /**
   *  constructor for LiveValidationForm - handles validation of LiveValidation fields belonging to this form on its submittal
   *  
   *  @var element {HTMLFormElement} - a dom element reference to the form to turn into a LiveValidationForm
   */
  initialize: function(element){
    this.name = $(element).attr("id");
    this.element = element;
    this.skipValidations = 0;
    this.submitWaitForAsync = [];
    this.isWaitForFormAsync = false;
    this.clk = undefined;

    // preserve the old onsubmit event
    this.oldOnSubmit = this.element.onsubmit || function(){};
    var self = this;

    this.onInvalid = function() {
        $(this).removeClass(self.validFormClass).addClass(self.invalidFormClass);
        $(".z_form_valid", this).hide();
        $(".z_form_invalid", this).fadeIn();
    };
    this.onValid = function() {
        $(this).removeClass(self.invalidFormClass).addClass(self.validFormClass);
        $(".z_form_invalid", this).hide();
        $(".z_form_valid", this).fadeIn();
    };

    $(element).submit(function(event) {
        event.zIsValidated = true;
        if (self.skipValidations === 0) {
            var result = true;
            var is_first = true;
            var i, len;
            var fields = self.getFields();

            self.submitWaitForAsync = [];
            self.isWaitForFormAsync = false;
            self.clk = this.clk;

            for(i = 0, len = fields.length; i < len; ++i ) {
                if (!fields[i].element.disabled) {
                    var ve = fields[i].validate(true, this.clk);
                    if (ve === 'async') {
                        self.submitWaitForAsync.push(fields[i]);
                    } else if (!ve) {
                        result = false;
                    }
                }
            }
            if (result === false) {
                self.submitWaitForAsync = [];
            }
            
            // Optionally check validations attached to the form itself
            // Only done if all other validations are done and passing
            if (result && self.submitWaitForAsync.length === 0) {
                var formValidation = $(this).data('z_live_validation');
                if (formValidation) {
                    var vf = formValidation.validate(true, this.clk);
                    if (vf === 'async') {
                        self.submitWaitForAsync = [formValidation];
                        self.isWaitForFormAsync = true;
                    } else if (!vf) {
                        result = false;
                    }
                }
            }
            if (self.submitWaitForAsync.length > 0) {
                event.stopImmediatePropagation();
                return false;
            } else if (!result) {
                self.onInvalid.call(this);
                event.stopImmediatePropagation();
                return false;
            } else {
                self.onValid.call(this);
                return z_form_submit_validated_do(event);
            }
        } else {
            self.skipValidations--;
            if (self.skipValidations === 0) {
                self.onValid.call(this);
                return z_form_submit_validated_do(event);
            } else {
                return false;
            }
        }
    });
  },
  
  /**
   *  destroy this instance and its events
   *
   * @var force {Boolean} - whether to force the destruction even if there are fields still associated
   */
  destroy: function(force){
    if (force || this.getFields().length === 0) {
        // remove events - set back to previous events
        this.element.onsubmit = this.oldOnSubmit;
        // remove from the instances namespace
        $(this.element).removeData("z_live_validation_instance");
        return true;
    } else {
        return false;
    }
  },
  
  /**
   * get the to-be-validated fields
   */
  getFields: function() {
    var fields = [];
    $("input,select,textarea", this.element).each(function() {
        var field = $(this).data('z_live_validation');
        if (field) {
            fields.push(field);
        }
    });
    return fields;
  },

  asyncResult: function(Validation, isValid){
      if (isValid){
          var index = $.inArray(Validation, this.submitWaitForAsync);
          if (index >= 0){
              this.submitWaitForAsync.splice(index, 1);
              if (this.submitWaitForAsync.length === 0){
                  // Optionally perform (and wait for) form-level validations
                  if (!this.isWaitForFormAsync) {
                      var formValidation = $(this.element).data('z_live_validation');
                      if (formValidation) {
                          var result = formValidation.validate(true, this.clk);
                          if (result === 'async') {
                              this.submitWaitForAsync = [formValidation];
                              this.isWaitForFormAsync = true;
                          } else if (!result) {
                              isValid = false;
                          } else {
                              isValid = true;
                          }
                      }
                  } else {
                      this.isWaitForFormAsync = false;
                  }

                  if (!this.isWaitForFormAsync) {
                      if (isValid){
                          // All validations were successful, resubmit (and skip validations for once)
                          this.skipValidations = 1;
                          var formObj = this.element;
                          this.onValid.call(this);
                          setTimeout(function(){ $(formObj).submit(); }, 0);
                      } else {
                          this.onInvalid.call(this);
                      }
                  }
              }
          }
      } else {
          if (this.submitWaitForAsync.length > 0) {
            this.onInvalid.call(this);
          }
          this.submitWaitForAsync = [];
      }
  }
}; // end of LiveValidationForm prototype




/*************************************** Validate class ****************************************/
/**
 * This class contains all the methods needed for doing the actual validation itself
 *
 * All methods are static so that they can be used outside the context of a form field
 * as they could be useful for validating stuff anywhere you want really
 *
 * All of them will return true if the validation is successful, but will raise a ValidationError if
 * they fail, so that this can be caught and the message explaining the error can be accessed ( as just 
 * returning false would leave you a bit in the dark as to why it failed )
 *
 * Can use validation methods alone and wrap in a try..catch statement yourself if you want to access the failure
 * message and handle the error, or use the Validate::now method if you just want true or false
 */

var Validate = {

    /**
     *  validates that the field has been filled in
     *
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation 
     *                            (DEFAULT: "Can't be empty!")
     */
    Presence: function(value, paramsObj){
        paramsObj = paramsObj || {};
        var message = paramsObj.failureMessage || "";
        if(value === '' || value === null || value === undefined){
            Validate.fail(message);
        }
        return true;
    },
    
    /**
     *  validates that the value is numeric, does not fall within a given range of numbers
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              notANumberMessage {String} - the message to show when the validation fails when value is not a number
     *                                (DEFAULT: "Must be a number!")
     *              notAnIntegerMessage {String} - the message to show when the validation fails when value is not an integer
     *                                (DEFAULT: "Must be a number!")
     *              wrongNumberMessage {String} - the message to show when the validation fails when is param is used
     *                                (DEFAULT: "Must be {is}!")
     *              tooLowMessage {String}    - the message to show when the validation fails when minimum param is used
     *                                (DEFAULT: "Must not be less than {minimum}!")
     *              tooHighMessage {String}   - the message to show when the validation fails when maximum param is used
     *                                (DEFAULT: "Must not be more than {maximum}!")
     *              is {Int}          - the length must be this long 
     *              minimum {Int}         - the minimum length allowed
     *              maximum {Int}         - the maximum length allowed
     *                         onlyInteger {Boolean} - if true will only allow integers to be valid
     *                                                             (DEFAULT: false)
     *
     *  NB. can be checked if it is within a range by specifying both a minimum and a maximum
     *  NB. will evaluate numbers represented in scientific form (ie 2e10) correctly as numbers       
     */
    Numericality: function(value, paramsObj){
        var suppliedValue = value;
        value = Number(value);
        paramsObj = paramsObj || {};
        var minimum = ((paramsObj.minimum) || (paramsObj.minimum === 0)) ? paramsObj.minimum : null;
        var maximum = ((paramsObj.maximum) || (paramsObj.maximum === 0)) ? paramsObj.maximum : null;
        var is = ((paramsObj.is) || (paramsObj.is === 0)) ? paramsObj.is : null;
        var notANumberMessage = paramsObj.notANumberMessage || "Must be a number.";
        var notAnIntegerMessage = paramsObj.notAnIntegerMessage || "Must be an integer.";
        var wrongNumberMessage = paramsObj.wrongNumberMessage || "Must be " + is + ".";
        var tooLowMessage = paramsObj.tooLowMessage || "Must not be less than " + minimum + ".";
        var tooHighMessage = paramsObj.tooHighMessage || "Must not be more than " + maximum + ".";
        
        if (!isFinite(value))
            Validate.fail(notANumberMessage);
        if (paramsObj.onlyInteger && (/\.0+$|\.$/.test(String(suppliedValue))  || value != parseInt(value,10)) )
            Validate.fail(notAnIntegerMessage);
        switch(true){
            case (is !== null):
                if( value != Number(is) ) Validate.fail(wrongNumberMessage);
                break;
            case (minimum !== null && maximum !== null):
                Validate.Numericality(value, {tooLowMessage: tooLowMessage, minimum: minimum});
                Validate.Numericality(value, {tooHighMessage: tooHighMessage, maximum: maximum});
                break;
            case (minimum !== null):
                if( value < Number(minimum) ) Validate.fail(tooLowMessage);
                break;
            case (maximum !== null):
                if( value > Number(maximum) ) Validate.fail(tooHighMessage);
                break;
        }
        return true;
    },
    
    /**
     *  validates against a RegExp pattern
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "")
     *              pattern {RegExp}    - the regular expression pattern
     *                            (DEFAULT: /./)
     *             negate {Boolean} - if set to true, will validate true if the pattern is not matched
   *                           (DEFAULT: false)
     *
     *  NB. will return true for an empty string, to allow for non-required, empty fields to validate.
     *    If you do not want this to be the case then you must either add a LiveValidation.PRESENCE validation
     *    or build it into the regular expression pattern
     */
    Format: function(value, paramsObj){
      value = String(value);
      paramsObj = paramsObj || {};
      var message = paramsObj.failureMessage || "";
      var pattern = paramsObj.pattern || /./;
      var negate = paramsObj.negate || false;
      if(!negate && !pattern.test(value)) Validate.fail(message); // normal
      if(negate && pattern.test(value)) Validate.fail(message); // negated
      return true;
    },
    
    /**
     *  validates that the field contains a valid email address
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "Must be a number!" or "Must be an integer!")
     */
    Email: function(value, paramsObj){
      paramsObj = paramsObj || {};
      var message = paramsObj.failureMessage || "";
      value = $.trim(value);
      // see validator_base_email.erl:43
      var re = /^$|^(("[^"\f\n\r\t\v\b]+")|([\w\!\#\$\%\&\'\*\+\-\~\/\^\`\|\{\}]+(\.[\w\!\#\$\%\&\'\*\+\-\~\/\^\`\|\{\}]+)*))@((([A-Za-z0-9\-])+\.)+[A-Za-z\-]{2,})$/;
      Validate.Format(value, { failureMessage: message, pattern: re } );
      return true;
    },

    /*
     *  validates that the field contains a valid date
     *
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "Incorrect Date")
     *              format {String} - l, m,b endian 
     *                             (DEFAULT: "l")
     *              separator {String} - a character which is not a number
     *                             (DEFAULT: "-")
     *
     */

    Date: function(value, paramsObj){
      function to_integer(value) {
          if (parseInt(value, 10) == value) {
              return parseInt(value, 10);
          } else {
              return parseInt("NaN", 10);
          }
      }

      paramsObj = paramsObj || {};
      var message = paramsObj.failureMessage || "Incorrect Date";
      var format = paramsObj.format || "l";
      var separator = paramsObj.separator || "-";
      value = $.trim(value);

      var date_components = value.split(separator);
      
      if (date_components.length != 3) {
          Validate.fail(message);
      } else {
          var day;
          var month;
          var year;

          not_a_number = to_integer(separator);
          if (!isNaN(not_a_number)) {
              throw "Seperator cannot be a number!";
          }
          if (format == 'l') {
              day = to_integer(date_components[0]);
              month = to_integer(date_components[1]);
              year = to_integer(date_components[2]);
          } else if (format == 'b') {
              day = to_integer(date_components[2]);
              month = to_integer(date_components[1]);
              year = to_integer(date_components[0]);
          } else if (format == 'm') {
              day = to_integer(date_components[1]);
              month = to_integer(date_components[0]);
              year = to_integer(date_components[2]);
          } else {
              throw "Bad date format error!";
          }
          var date_object = new Date(year, month-1, day);
          if (!((date_object.getDate() == day) && (date_object.getMonth()+1 == month) && (date_object.getFullYear() == year))) {
              Validate.fail(message);
          }
      }
      return true;
    },
    
    /**
     *  validates the length of the value
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              wrongLengthMessage {String} - the message to show when the fails when is param is used
     *                                (DEFAULT: "Must be {is} characters long!")
     *              tooShortMessage {String}  - the message to show when the fails when minimum param is used
     *                                (DEFAULT: "Must not be less than {minimum} characters long!")
     *              tooLongMessage {String}   - the message to show when the fails when maximum param is used
     *                                (DEFAULT: "Must not be more than {maximum} characters long!")
     *              is {Int}          - the length must be this long 
     *              minimum {Int}         - the minimum length allowed
     *              maximum {Int}         - the maximum length allowed
     *
     *  NB. can be checked if it is within a range by specifying both a minimum and a maximum       
     */
    Length: function(value, paramsObj){
        value = String(value);
        paramsObj = paramsObj || {};
        var minimum = ((paramsObj.minimum) || (paramsObj.minimum === 0)) ? paramsObj.minimum : null;
        var maximum = ((paramsObj.maximum) || (paramsObj.maximum === 0)) ? paramsObj.maximum : null;
        var is = ((paramsObj.is) || (paramsObj.is === 0)) ? paramsObj.is : null;
        var wrongLengthMessage = paramsObj.wrongLengthMessage || "Must be " + is + " characters long.";
        var tooShortMessage = paramsObj.tooShortMessage || "Must not be less than " + minimum + " characters long.";
        var tooLongMessage = paramsObj.tooLongMessage || "Must not be more than " + maximum + " characters long.";
        switch(true){
            case (is !== null):
                if( value.length != Number(is) ) Validate.fail(wrongLengthMessage);
                break;
            case (minimum !== null && maximum !== null):
                Validate.Length(value, {tooShortMessage: tooShortMessage, minimum: minimum});
                Validate.Length(value, {tooLongMessage: tooLongMessage, maximum: maximum});
                break;
            case (minimum !== null):
                if( value.length < Number(minimum) ) Validate.fail(tooShortMessage);
                break;
            case (maximum !== null):
                if( value.length > Number(maximum) ) Validate.fail(tooLongMessage);
                break;
            default:
                throw new Error("Validate::Length - Length(s) to validate against must be provided");
        }
        return true;
    },
    
    /**
     *  validates that the value falls within a given set of values
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "Must be included in the list!")
     *              within {Array}      - an array of values that the value should fall in 
     *                            (DEFAULT: []) 
     *              allowNull {Bool}    - if true, and a null value is passed in, validates as true
     *                            (DEFAULT: false)
     *             partialMatch {Bool}  - if true, will not only validate against the whole value to check but also if it is a substring of the value 
     *                            (DEFAULT: false)
     *             caseSensitive {Bool} - if false will compare strings case insensitively
     *                          (DEFAULT: true)
     *             negate {Bool}    - if true, will validate that the value is not within the given set of values
     *                            (DEFAULT: false)      
     */
    Inclusion: function(value, paramsObj){
      paramsObj = paramsObj || {};
      var message = paramsObj.failureMessage || "Must be included in the list!";
      var caseSensitive = (paramsObj.caseSensitive === false) ? false : true;
      if(paramsObj.allowNull && value === null)
        return true;
      if(!paramsObj.allowNull && value === null)
        Validate.fail(message);
      var within = paramsObj.within || [];
      var length;

      //if case insensitive, make all strings in the array lowercase, and the value too
      if(!caseSensitive){
        var lowerWithin = [];
        length = within.length;
        for(var j = 0; j < length; ++j){
          var item = within[j];
          if(typeof item == 'string')
            item = item.toLowerCase();
          lowerWithin.push(item);
        }
        within = lowerWithin;
        if(typeof value == 'string')
          value = value.toLowerCase();
      }
      var found = false;
      length = within.length;
      for(var i = 0; i < length; ++i){
        if(within[i] == value) found = true;
        if(paramsObj.partialMatch){
          if(value.indexOf(within[i]) != -1) found = true;
        }
      }
      if( (!paramsObj.negate && !found) || (paramsObj.negate && found) )
        Validate.fail(message);
      return true;
    },
    
    /**
     *  validates that the value does not fall within a given set of values
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "Must not be included in the list!")
     *              within {Array}      - an array of values that the value should not fall in 
     *                            (DEFAULT: [])
     *              allowNull {Bool}    - if true, and a null value is passed in, validates as true
     *                            (DEFAULT: false)
     *             partialMatch {Bool}  - if true, will not only validate against the whole value to check but also if it is a substring of the value 
     *                            (DEFAULT: false)
     *             caseSensitive {Bool} - if false will compare strings case insensitively
     *                          (DEFAULT: true)     
     */
    Exclusion: function(value, paramsObj){
      paramsObj = paramsObj || {};
      paramsObj.failureMessage = paramsObj.failureMessage || "Must not be included in the list";
      paramsObj.negate = true;
      Validate.Inclusion(value, paramsObj);
      return true;
    },
    
    /**
     *  validates that the value matches that in another field
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "Does not match!")
     *              match {String}      - id of the field that this one should match            
     */
    Confirmation: function(value, paramsObj){
        if(!paramsObj.match)
            throw new Error("Validate::Confirmation - Error validating confirmation: Id of element to match must be provided");
        paramsObj = paramsObj || {};
        var message = paramsObj.failureMessage || "Does not match.";
        var match = paramsObj.match.nodeName ? paramsObj.match : document.getElementById(paramsObj.match);
        if(!match)
            throw new Error("Validate::Confirmation - There is no reference with name of, or element with id of '" + paramsObj.match + "'");
        if(value != match.value){
          Validate.fail(message);
        }
        return true;
    },
    
    /**
     *  validates that the value is true (for use primarily in detemining if a checkbox has been checked)
     *  
     *  @var value {mixed} - value to be checked if true or not (usually a boolean from the checked value of a checkbox)
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation 
     *                            (DEFAULT: "Must be accepted!")
     */
    Acceptance: function(value, paramsObj){
        paramsObj = paramsObj || {};
        var message = paramsObj.failureMessage || "Must be accepted.";
        if(!value){
          Validate.fail(message);
        }
        return true;
    },
    
   /**
     *  validates against a custom function that returns true or false (or throws a Validate.Error) when passed the value
     *  
     *  @var value {mixed} - value to be checked
     *  @var paramsObj {Object} - parameters for this particular validation, see below for details
     *
     *  paramsObj properties:
     *              failureMessage {String} - the message to show when the field fails validation
     *                            (DEFAULT: "")
     *              against {Function}      - a function that will take the value and object of arguments and return true or false 
     *                            (DEFAULT: function(){ return true; })
     *              args {Object}     - an object of named arguments that will be passed to the custom function so are accessible through this object within it 
     *                            (DEFAULT: {})
     */
    Custom: function(value, paramsObj, isSubmit, submitTrigger){
        paramsObj = paramsObj || {};
        var against = paramsObj.against || function(){ return true; };
        var args = paramsObj.args || {};
        var message = paramsObj.failureMessage || "";
        var result;

        if (typeof against == "string") {
            result = z_call_function_by_name(against, window, value, args, isSubmit, submitTrigger);
        } else {
            result = against(value, args, isSubmit, submitTrigger);
        }
        if (result === 'async') {
          return 'async';
        } else {
          if(!result) Validate.fail(message);
          return true;
        }
    },


    /**
     * Performs a postback, delays the check till the postback is returned. till then a spinner is shown
     * next to the input element. 
     */
    Postback: function(value, paramsObj, isSubmit, submitTrigger) {
        paramsObj = paramsObj || {};
        var against = paramsObj.against || function(){ return true; };
        var args = paramsObj.args || {};
        var message = paramsObj.failureMessage || "";

        if (!against(value, args, isSubmit, submitTrigger)) {
            Validate.fail(message);
        } else if (paramsObj.z_postback) {
            // Perform the async postback
            extraParams = [];
            if (isSubmit) {
                extraParams.push({name: 'z_submitter', value: (submitTrigger && submitTrigger.name) ? submitTrigger.name : ''});
            }
            z_queue_postback(paramsObj.z_id, paramsObj.z_postback, extraParams);
            return 'async';
        } else {
            return true;
        }
     },

  
    /**
     *  validates whatever it is you pass in, and handles the validation error for you so it gives a nice true or false reply
     *
     *  @var validationFunction {Function} - validation function to be used (ie Validation.validatePresence )
     *  @var value {mixed} - value to be checked if true or not (usually a boolean from the checked value of a checkbox)
     *  @var validationParamsObj {Object} - parameters for doing the validation, if wanted or necessary
     */
    now: function(validationFunction, value, validationParamsObj){
      if(!validationFunction)
        throw new Error("Validate::now - Validation function must be provided!");
      var isValid = true;
      try {
        validationFunction(value, validationParamsObj || {});
      } catch(error) {
        if (error instanceof Validate.Error) {
          isValid =  false;
        } else {
          throw error;
        }
      } finally {
        return isValid;
      }
    },
    
    /**
     * shortcut for failing throwing a validation error
     *
     *  @var errorMessage {String} - message to display
     */
    fail: function(errorMessage){
      throw new Validate.Error(errorMessage);
    },
    
    Error: function(errorMessage){
      this.message = errorMessage;
      this.name = 'ValidationError';
    }

};
/* inputoverlay js
----------------------------------------------------------

@package:	Zotonic 2010	
@Author:	Marc Worrell <marc@worrell.nl>

Copyright 2010 Marc Worrell

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
 
http://www.apache.org/licenses/LICENSE-2.0
 
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---------------------------------------------------------- */

/*
This widget overlays a label field with an input field.	 When the input
is empty the label is visible.	When there is content then the label is hidden.

HTML:

<p class="do_inputoverlay">
	<span>Username</span>
	<input type="text" id="username" name="username" value="" />
</p>

CSS:

p.do_inputoverlay {
	margin: 0px;
	padding: 0px;
	position: relative;
	height: 40px;
	font-size: 18px;
}

p.do_inputoverlay input {
	position: absolute;
	left: 0px;
	background: none;
	font-size: 18px;
}

p.do_inputoverlay span {
	position: absolute;
	left: 8px;
	top: 5px;
	color: #aaa;
}

p.do_inputoverlay span.focus {
	color: #d8d8d8;
}

p.do_inputoverlay span.hidden {
	display: none;
}

*/

$.widget("ui.inputoverlay", 
{
	_init: function() 
	{
		var self = this;
		var obj	 = this.element;
		var input = $('input', obj);
		var span = $('span', obj);
		
		if (!input.length) {
			input = $('textarea', obj);
		}
		if ($(input).val() != "") {
			$(span).addClass('hidden');
		}

		var func = function(focus) {
			if ($(input).val() == "") {
				if (focus) {
					$(span).removeClass('hidden').addClass('focus');
				} else {
					$(span).removeClass('hidden').removeClass('focus');
				}
			} else {
				$(span).removeClass('focus').addClass('hidden');
			}
		};
		
		input.change(function() {
			func(true);
		}).focus(function() {
			func(true);
		}).blur(function() {
			func(false);
		}).keydown(function() {
			setTimeout(function(){func(true);},10);
		}).keyup(function() {
			func(true);
		});
		
		input.closest("form").bind("reset", function() {
			setTimeout(function(){func(true);},10);
		});
		
		span.click(function() {
			input.focus();
		});
		
		if (input.attr('autocomplete') == 'on') {
			setInterval(function() {
				if ($(input).val() == "") {
					$(span).removeClass('hidden');
				} else {
					$(span).addClass('hidden');
				}
			}, 100);
		}
	}	 
});
/**
 * Copyright (c) 2009 Sergiy Kovalchuk (serg472@gmail.com)
 * 
 * Dual licensed under the MIT (http://www.opensource.org/licenses/mit-license.php)
 * and GPL (http://www.opensource.org/licenses/gpl-license.php) licenses.
 *  
 * Following code is based on Element.mask() implementation from ExtJS framework (http://extjs.com/)
 *
 */
;(function($){
	
	/**
	 * Displays loading mask over selected element(s). Accepts both single and multiple selectors.
	 *
	 * @param label Text message that will be displayed on top of the mask besides a spinner (optional). 
	 * 				If not provided only mask will be displayed without a label or a spinner.  	
	 * @param delay Delay in milliseconds before element is masked (optional). If unmask() is called 
	 *              before the delay times out, no mask is displayed. This can be used to prevent unnecessary 
	 *              mask display for quick processes.   	
	 */
	$.fn.mask = function(label, delay){
		$(this).each(function() {
			if(delay !== undefined && delay > 0) {
		        var element = $(this);
		        element.data("_mask_timeout", setTimeout(function() { $.maskElement(element, label)}, delay));
			} else {
				$.maskElement($(this), label);
			}
		});
	};
	
	/**
	 * Removes mask from the element(s). Accepts both single and multiple selectors.
	 */
	$.fn.unmask = function(){
		$(this).each(function() {
			$.unmaskElement($(this));
		});
	};
	
	/**
	 * Checks if a single element is masked. Returns false if mask is delayed or not displayed. 
	 */
	$.fn.isMasked = function(){
		return this.hasClass("masked");
	};

	/**
	 * Show or update the upload progressbar
	 */
	$.fn.maskProgress = function(value){
		$(this).each(function() {
			$.maskProgress($(this), value);
		});
	};

	$.maskElement = function(element, label){
	
		//if this element has delayed mask scheduled then remove it and display the new one
		if (element.data("_mask_timeout") !== undefined) {
			clearTimeout(element.data("_mask_timeout"));
			element.removeData("_mask_timeout");
		}

		if(element.isMasked()) {
			$.unmaskElement(element);
		}
		
		if(element.css("position") == "static") {
			element.addClass("masked-relative");
		}
		
		element.addClass("masked");
		
		var maskDiv = $('<div class="loadmask"></div>');
		
		//auto height fix for IE
		if(navigator.userAgent.toLowerCase().indexOf("msie") > -1){
			maskDiv.height(element.height() + parseInt(element.css("padding-top")) + parseInt(element.css("padding-bottom")));
			maskDiv.width(element.width() + parseInt(element.css("padding-left")) + parseInt(element.css("padding-right")));
		}
		
		//fix for z-index bug with selects in IE6
		if(navigator.userAgent.toLowerCase().indexOf("msie 6") > -1){
			element.find("select").addClass("masked-hidden");
		}
		
		element.append(maskDiv);
		
		if ($(element).progressbar != undefined) {
			var maskProgressDiv = $('<div class="loadmask-progress" style="display:none;"></div>');
			element.append(maskProgressDiv);
			element.find(".loadmask-progress").progressbar({value: 0});
		}
		if(label !== undefined) {
			var maskMsgDiv = $('<div class="loadmask-msg" style="display:none;"></div>');
			maskMsgDiv.append('<div>' + label + '</div>');
			element.append(maskMsgDiv);
			
			//calculate center position
			maskMsgDiv.css("top", Math.round(element.height() / 2 - (maskMsgDiv.height() - parseInt(maskMsgDiv.css("padding-top")) - parseInt(maskMsgDiv.css("padding-bottom"))) / 2)+"px");
			maskMsgDiv.css("left", Math.round(element.width() / 2 - (maskMsgDiv.width() - parseInt(maskMsgDiv.css("padding-left")) - parseInt(maskMsgDiv.css("padding-right"))) / 2)+"px");
			
			maskMsgDiv.show();
		}
	};
	
	$.maskProgress = function(element, value){
		if ($(element).progressbar != undefined) {
			element.find(".loadmask-progress").show().progressbar('option', 'value', value);
			element.find(".loadmask-msg").hide();
		}
	};
	
	$.unmaskElement = function(element){
		//if this element has delayed mask scheduled then remove it
		if (element.data("_mask_timeout") !== undefined) {
			clearTimeout(element.data("_mask_timeout"));
			element.removeData("_mask_timeout");
		}
		
		element.find(".loadmask-msg,.loadmask-progress,.loadmask").remove();
		element.removeClass("masked");
		element.removeClass("masked-relative");
		element.find("select").removeClass("masked-hidden");
	};
 
})(jQuery);
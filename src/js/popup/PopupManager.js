/* @flow */
'use strict';

import EventEmitter from 'events';
import * as POPUP from '../constants/popup';
import { showPopupRequest } from './showPopupRequest';
import type { ConnectSettings } from '../data/ConnectSettings';
import type { CoreMessage, Deferred } from '../types';
import { getOrigin } from '../utils/networkUtils';
import { create as createDeferred } from '../utils/deferred';

const POPUP_WIDTH: number = 640;
const POPUP_HEIGHT: number = 500;
// const POPUP_REQUEST_TIMEOUT: number = 602;
const POPUP_REQUEST_TIMEOUT: number = 999;
const POPUP_CLOSE_INTERVAL: number = 500;
const POPUP_OPEN_TIMEOUT: number = 2000;

export default class PopupManager extends EventEmitter {
    _window: any; // Window
    settings: ConnectSettings;
    src: string;
    origin: string;
    locked: boolean;
    requestTimeout: number = 0;
    openTimeout: number;
    closeInterval: number = 0;
    lazyLoad: ?Deferred<boolean>;
    handleLazyLoading: (event: MessageEvent) => void;
    extension: boolean = false;
    handleExtensionConnect: () => void;
    handleExtensionMessage: () => void;
    extensionPort: ?ChromePort;
    broadcast: ?string;

    constructor(settings: ConnectSettings) {
        super();
        this.settings = settings;
        this.src = settings.popupSrc;
        this.origin = getOrigin(settings.popupSrc);
        this.handleLazyLoading = this.handleLazyLoading.bind(this);
        this.handleExtensionConnect = this.handleExtensionConnect.bind(this);
        this.handleExtensionMessage = this.handleExtensionMessage.bind(this);
        this.extension = (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.onConnect !== 'undefined');
    }

    request(lazyLoad: boolean = false): void {
        // popup request
        // TODO: ie - open imediately and hide it but post handshake after timeout

        // bring popup window to front
        if (this.locked) {
            if (this._window) {
                if (this.extension) {
                    chrome.tabs.get(this._window.id, tab => {
                        if (!tab) return;
                        chrome.tabs.highlight(
                            { tabs: tab.index }
                        )
                    })
                } else {
                    this._window.focus();
                }
            }
            return;
        }

        this.lazyLoad = lazyLoad ? createDeferred(POPUP.INIT) : null;
        if (this.lazyLoad) {
            if (!this.extension) {
                window.addEventListener('message', this.handleLazyLoading, false);
            }
        }

        const openFn: Function = this.open.bind(this);
        this.locked = true;
        if (!this.settings.supportedBrowser) {
            openFn();
        } else {
            this.requestTimeout = window.setTimeout(() => {
                this.requestTimeout = 0;
                openFn();
            }, lazyLoad || this.extension ? 1 : POPUP_REQUEST_TIMEOUT);
        }
    }

    cancel(): void {
        this.close();
    }

    unlock(): void {
        this.locked = false;
    }

    open(): void {
        if (!this.settings.supportedBrowser) {
            this.openWrapper(this.src + '#unsupported');
            return;
        }

        this.openWrapper(this.lazyLoad ? this.src + '#loading' : this.src);

        this.closeInterval = window.setInterval(() => {
            if (this._window) {
                if (this.extension) {
                    chrome.tabs.get(this._window.id, tab => {
                        if (!tab) {
                            this.close();
                            this.emit(POPUP.CLOSED);
                        }
                    });
                } else if (this._window.closed) {
                    this.close();
                    this.emit(POPUP.CLOSED);
                }
            }
        }, POPUP_CLOSE_INTERVAL);

        this.openTimeout = window.setTimeout(() => {
            if (!(this._window && !this._window.closed)) {
                this.close();
                showPopupRequest(this.open.bind(this), () => { this.emit(POPUP.CLOSED); });
            }
        }, POPUP_OPEN_TIMEOUT);
    }

    openWrapper(url: string): void {
        if (this.extension) {
            // connect with this tab
            chrome.runtime.onConnect.removeListener(this.handleExtensionConnect);
            chrome.runtime.onConnect.addListener(this.handleExtensionConnect);

            chrome.tabs.create({
                url,
            }, tab => {
                this._window = tab;
            });

        } else {
            this._window = window.open('', '_blank');
            if (this._window) {
                this._window.location.href = url; // otherwise android/chrome loose window.opener reference
            }
        }
    }

    handleExtensionConnect(port: ChromePort): void {
        if (this._window && this._window.id !== port.sender.tab.id) {
            return;
        }
        this.extensionPort = port;
        this.extensionPort.onMessage.addListener(this.handleExtensionMessage);
    }

    handleExtensionMessage(message: Object): void {
        if (!this.extensionPort) return;
        if (message === POPUP.EXTENSION_REQUEST) {
            this.extensionPort.postMessage( { type: POPUP.EXTENSION_REQUEST, broadcast: this.broadcast } );
        } else if (message === POPUP.INIT && this.lazyLoad) {
            this.lazyLoad.resolve(true);
        } else if (message === POPUP.EXTENSION_USB_PERMISSIONS) {
            chrome.tabs.create({
                url: 'usb-permissions.html'
            })
        }
    }

    setBroadcast(broadcast: ?string) {
        this.broadcast = broadcast;
    }

    handleLazyLoading(event: MessageEvent): void {
        if (this.lazyLoad && event.data && event.data === POPUP.INIT) {
            this.lazyLoad.resolve(true);
            window.removeEventListener('message', this.handleLazyLoading, false);
        }
    }

    async resolveLazyLoad(): Promise<void> {
        if (this.lazyLoad) {
            await this.lazyLoad.promise;
        }
        if (this.extension) {
            if (this.extensionPort)
                this.extensionPort.postMessage( { type: POPUP.INIT  } );
        } else {
            this._window.postMessage({ type: POPUP.INIT }, this.origin);
        }
    }

    close(): void {
        if (this.requestTimeout) {
            window.clearTimeout(this.requestTimeout);
            this.requestTimeout = 0;
        }

        if (this.openTimeout) {
            window.clearTimeout(this.openTimeout);
            this.openTimeout = 0;
        }
        if (this.closeInterval) {
            window.clearInterval(this.closeInterval);
            this.closeInterval = 0;
        }

        if (this.extensionPort) {
            // chrome.runtime.onConnect.removeListener(this.handleExtensionConnect);
            this.extensionPort.disconnect();
            this.extensionPort = null;
        }

        if (this._window) {
            if (this.extension) {
                chrome.tabs.remove(this._window.id);
            } else {
                this._window.close();
            }
            this._window = null;
        }
    }

    postMessage(message: CoreMessage): void {
        // post message before popup request finalized
        if (this.requestTimeout) {
            return;
        }

        // device needs interaction but there is no popup/ui
        // maybe popup request wasn't handled
        // ignore "ui_request_window" type
        if (!this._window && message.type !== 'ui_request_window' && this.openTimeout) {
            this.close();
            showPopupRequest(this.open.bind(this), () => { this.emit(POPUP.CLOSED); });
            return;
        }

        // post message to popup window
        if (this._window) { this._window.postMessage(message, this.origin); }
    }

    onBeforeUnload() {
        this.close();
    }

    cancelOpenTimeout() {
        this._window.clearTimeout(this.openTimeout);
    }

    cancelRequestTimeout() {
        this._window.clearTimeout(this.requestTimeout);
    }
}

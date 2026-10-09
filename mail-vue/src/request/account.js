import http from '@/axios/index.js'

export function accountList(accountId, size, lastSort) {
    return http.get('/account/list', {params: {accountId, size, lastSort}});
}

export function accountAdd(email,token) {
    return http.post('/account/add', {email,token})
}

export function accountSetName(accountId,name) {
    return http.put('/account/setName', {name,accountId})
}

export function accountDelete(accountId) {
    return http.delete('/account/delete', {params: {accountId}})
}

export function accountSetAllReceive(accountId) {
    return http.put('/account/setAllReceive', {accountId})
}

export function accountSetAsTop(accountId) {
    return http.put('/account/setAsTop', {accountId})
}

export function forwardList(accountId) {
    return http.get('/account/forward', {params: {accountId}});
}

export function forwardRefresh(accountId) {
    return http.post('/account/forward/refresh', {accountId});
}

export function forwardAdd(accountId, email) {
    return http.post('/account/forward', {accountId, email});
}

export function forwardDelete(accountId, forwardId) {
    return http.delete('/account/forward', {params: {accountId, forwardId}});
}

export function forwardResend(accountId, forwardId) {
    return http.post('/account/forward/resend', {accountId, forwardId});
}

export function userForwardList(userId) {
    return http.get('/user/forward', {params: {userId}});
}

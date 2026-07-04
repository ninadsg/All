const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const API_BASE_URL = process.env.API_BASE_URL || 'https://fam-way-pro.onrender.com';
const OWNER_USER_ID = parseInt(process.env.OWNER_USER_ID || '8558052873');
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'clerkMM';
const PORT = process.env.PORT || 10000;

// ==================== STORAGE ====================
let escrows = {};
let pendingPayments = {};
let verifiedPayments = new Set();
let agreements = {};
let releaseAgreements = {};
let refundAgreements = {};
let pinnedMessages = {};
let userActiveDeal = {};
let userStats = {};
let userUpi = {};
let promotedEscrowers = new Set();
let escrowerUsernameMap = {};
let dealFormMessages = {};
let pendingEscrowSelection = {};
let dealCounter = 409; // START FROM 409 (408 already done)

// ==================== PROMOTED BY USERNAME STORAGE ====================
if (!global.promotedByUsername) global.promotedByUsername = {};

// ==================== ADDUPI STATE ====================
let addUpiState = {};
let customerCareState = {};

// ==================== API HELPER ====================
const api = {
    async generateQR(amount, gmailKey) {
        if (!gmailKey) return null;
        try {
            const response = await axios.get(`${API_BASE_URL}/qr-gen`, {
                params: { amount, gmail_key: gmailKey }
            });
            if (response.data && response.data.success) {
                return response.data.data;
            }
            return null;
        } catch (error) {
            console.error('QR Generation Error:', error.message);
            return null;
        }
    },
    async verifyPayment(orderId, gmailKey) {
        if (!gmailKey) return null;
        try {
            const response = await axios.get(`${API_BASE_URL}/verify`, {
                params: { order_id: orderId, gmail_key: gmailKey }
            });
            if (response.data && response.data.success) {
                return response.data.data;
            }
            return null;
        } catch (error) {
            console.error('Verify Payment Error:', error.message);
            return null;
        }
    }
};

// ==================== HELPER FUNCTIONS ====================
function isOwner(userId) {
    return userId === OWNER_USER_ID;
}

function isEscrower(userId, username) {
    if (promotedEscrowers.has(userId)) return true;
    if (isOwner(userId)) return true;
    
    if (username && global.promotedByUsername && global.promotedByUsername[username.toLowerCase()]) {
        promotedEscrowers.add(userId);
        escrowerUsernameMap[userId] = username;
        delete global.promotedByUsername[username.toLowerCase()];
        return true;
    }
    
    return false;
}

function getEscrowerData(username) {
    return userUpi[username.toLowerCase()] || null;
}

function getAllEscrowers() {
    const escrowers = [];
    const seenUsernames = new Set();
    for (const userId of promotedEscrowers) {
        const username = escrowerUsernameMap[userId];
        if (username && !seenUsernames.has(username.toLowerCase())) {
            seenUsernames.add(username.toLowerCase());
            const data = getEscrowerData(username);
            escrowers.push({
                userId,
                username,
                upi: data ? data.upi : 'Not set',
                hasGmail: !!(data && data.gmailKey),
                manual: !!(data && data.manual),
                hasQr: !!(data && data.qrPhoto)
            });
        }
    }
    return escrowers;
}

function normalizeUsername(username) {
    return username ? username.toLowerCase() : '';
}

function generateDealId() {
    dealCounter++;
    return String(dealCounter).padStart(3, '0');
}

function findDealByUsername(username, chatId, statusFilter) {
    const usernameLower = normalizeUsername(username);
    for (const [dealId, escrow] of Object.entries(escrows)) {
        if (escrow.groupId !== chatId) continue;
        if (statusFilter && escrow.status !== statusFilter) continue;
        if (normalizeUsername(escrow.buyer) === usernameLower || normalizeUsername(escrow.seller) === usernameLower) {
            return dealId;
        }
    }
    return null;
}

function updateUserStats(username, dealId, amount, role, action) {
    if (!userStats[username]) {
        userStats[username] = {
            totalDeals: 0,
            completed: 0,
            pending: 0,
            totalAmount: 0,
            deals: []
        };
    }
    userStats[username].totalDeals++;
    userStats[username].totalAmount += parseFloat(amount);
    userStats[username].deals.push({
        dealId,
        amount,
        role,
        action,
        status: action === 'release' ? 'completed' : 'pending'
    });
    if (action === 'release') userStats[username].completed++;
    else if (action === 'refund') userStats[username].pending++;
}

async function pinMessage(bot, chatId, messageId) {
    try {
        await bot.pinChatMessage(chatId, messageId);
        return true;
    } catch (e) { return false; }
}

async function unpinMessage(bot, chatId, messageId) {
    try {
        await bot.unpinChatMessage(chatId, messageId);
        return true;
    } catch (e) { return false; }
}

// ==================== FORMATTING FUNCTIONS ====================
function formatAgreement(dealId, escrow, agreedCount) {
    const buyerAgreed = agreements[dealId]?.buyerAgreed ? '✅ Agreed' : '⏳ Pending';
    const sellerAgreed = agreements[dealId]?.sellerAgreed ? '✅ Agreed' : '⏳ Pending';
    return `
📋 ESCROW AGREEMENT
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
📅 ${new Date(escrow.timestamp * 1000).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}

👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}

✅ @${escrow.buyer}: ${buyerAgreed}
✅ @${escrow.seller}: ${sellerAgreed}

📊 Progress: ${agreedCount}/2

💡 @${escrow.buyer} → /agree
💡 @${escrow.seller} → /agree

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
}

function formatDealForm(dealId, escrow) {
    const escrowData = getEscrowerData(escrow.escrowerUsername);
    const upi = escrowData ? escrowData.upi : 'Not set';
    const mode = (escrowData && escrowData.gmailKey) ? '🔐 Auto (Gmail)' : '📱 Manual (QR)';
    return `
📋 DEAL FORM #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Pay to: ${upi}
📱 Mode: ${mode}
🆔 Order: ${escrow.orderId || 'N/A'}

⏳ AWAITING PAYMENT

🔔 @${escrow.buyer} please complete payment

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
}

function formatReleaseComplete(dealId, escrow, sellerUpi) {
    return `
✅ DEAL COMPLETED #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
📅 ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}

💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}

👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Seller UPI: ${sellerUpi}
🆔 TXN: ${escrow.txnId || 'N/A'}

✅ Payment Released!

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
}

function formatRefundComplete(dealId, escrow, buyerUpi) {
    return `
↩️ DEAL REFUNDED #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
📅 ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}

💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}

👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Buyer UPI: ${buyerUpi}
🆔 TXN: ${escrow.txnId || 'N/A'}

↩️ Refunded to Buyer

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
}

// ==================== PAYMENT CHECKER ====================
async function checkPendingPayments(bot) {
    while (true) {
        try {
            for (const [orderId, data] of Object.entries(pendingPayments)) {
                const dealId = data.dealId;
                if (verifiedPayments.has(orderId)) continue;
                if (!escrows[dealId]) continue;
                const escrow = escrows[dealId];
                const escrowData = getEscrowerData(escrow.escrowerUsername);
                if (!escrowData || !escrowData.gmailKey) continue;
                const verification = await api.verifyPayment(orderId, escrowData.gmailKey);
                if (verification && verification.status === 'paid') {
                    verifiedPayments.add(orderId);
                    if (escrows[dealId] && escrows[dealId].status === 'awaiting_payment') {
                        escrows[dealId].status = 'payment_received';
                        escrows[dealId].txnId = verification.txn_id;
                        escrows[dealId].payerName = verification.payer_name;
                        await paymentVerifiedAndCleanup(bot, dealId, verification);
                        delete pendingPayments[orderId];
                    }
                }
            }
        } catch (err) {
            console.error('Payment check error:', err);
        }
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

async function paymentVerifiedAndCleanup(bot, dealId, txData) {
    const escrow = escrows[dealId];
    if (!escrow) return;
    if (escrow.qrMessageId) {
        try { await bot.deleteMessage(escrow.groupId, escrow.qrMessageId); } catch (e) {}
    }
    if (escrow.formMessageId) {
        try { await bot.deleteMessage(escrow.groupId, escrow.formMessageId); } catch (e) {}
    }
    const finalText = `
✅ PAYMENT VERIFIED! #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🔐 Escrower: @${escrow.escrowerUsername}
🆔 TXN: ${txData.txn_id || 'N/A'}

⏳ Escrower will release soon.
    `;
    const sentMsg = await bot.sendMessage(escrow.groupId, finalText);
    await pinMessage(bot, escrow.groupId, sentMsg.message_id);
    pinnedMessages[escrow.groupId] = sentMsg.message_id;
    await bot.sendMessage(escrow.escrowerId, `
🔔 PAYMENT RECEIVED! #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🆔 TXN: ${txData.txn_id || 'N/A'}

Type /release ${dealId} to start release
    `);
}

// ==================== BOT SETUP ====================
const bot = new TelegramBot(TOKEN, { polling: true });

// --- DASHBOARD (DM) with 2x2 Grid ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'User';
    const chatType = msg.chat.type;

    if (chatType === 'private') {
        await showDashboard(chatId, userId, username);
    } // else ignore in group
});

async function showDashboard(chatId, userId, username) {
    const isEscrowerUser = isEscrower(userId, username);
    const stats = userStats[username] || { totalDeals: 0, completed: 0, pending: 0, totalAmount: 0 };
    let text = `
👋 Welcome, @${username}!

This is your personal deal dashboard.

📊 Your Stats:
• Total Deals: ${stats.totalDeals}
• Completed: ${stats.completed}
• Pending: ${stats.pending}
• Total Amount: ₹${stats.totalAmount}
    `;
    
    // 2x2 Grid Layout: [Row1] [Row2]
    const keyboard = [
        [{ text: '📊 My Stats' }, { text: '📋 My Dealing History' }],
        [{ text: '⏳ My Pending Deals' }, { text: '🔍 View Past Deal Info' }]
    ];
    
    if (isEscrowerUser) {
        keyboard.push([{ text: '🔐 Admin Panel' }]);
    }
    
    // Add Customer Care button at the bottom
    keyboard.push([{ text: '📞 Customer Care' }]);
    
    await bot.sendMessage(chatId, text, {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
}

// --- Handle keyboard button presses ---
bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'User';
    const text = msg.text;

    if (msg.chat.type !== 'private') return;

    // Skip commands
    if (text.startsWith('/')) return;

    // Handle Customer Care
    if (text === '📞 Customer Care') {
        customerCareState[chatId] = { step: 'query' };
        await bot.sendMessage(chatId, `
📞 CUSTOMER CARE
━━━━━━━━━━━━━━━━━━━━━

Please type your query below.
Our team will get back to you shortly.

Type /cancel to cancel.
        `);
        return;
    }

    // Handle Customer Care query
    if (customerCareState[chatId] && customerCareState[chatId].step === 'query') {
        const query = text;
        
        // Forward to all escrowers and owner
        const escrowers = getAllEscrowers();
        let sentCount = 0;
        
        // Send to owner
        try {
            await bot.sendMessage(OWNER_USER_ID, `
📞 CUSTOMER CARE QUERY
━━━━━━━━━━━━━━━━━━━━━

👤 User: @${username}
🆔 User ID: ${userId}
📝 Query: ${query}

━━━━━━━━━━━━━━━━━━━━━
Reply to this user by sending a message to @${username}
            `);
            sentCount++;
        } catch (e) {}
        
        // Send to all escrowers
        for (const escrower of escrowers) {
            try {
                await bot.sendMessage(escrower.userId, `
📞 CUSTOMER CARE QUERY
━━━━━━━━━━━━━━━━━━━━━

👤 User: @${username}
🆔 User ID: ${userId}
📝 Query: ${query}

━━━━━━━━━━━━━━━━━━━━━
Reply to this user by sending a message to @${username}
                `);
                sentCount++;
            } catch (e) {}
        }
        
        await bot.sendMessage(chatId, `
✅ Your query has been sent to our support team (${sentCount} people notified).

You will be contacted shortly.

Type /start to go back.
        `);
        delete customerCareState[chatId];
        return;
    }

    const stats = userStats[username] || { totalDeals: 0, completed: 0, pending: 0, totalAmount: 0, deals: [] };

    if (text === '📊 My Stats') {
        const reply = `
📊 YOUR STATS
━━━━━━━━━━━━━━━━━━━━━

👤 @${username}

• Total Deals: ${stats.totalDeals}
• Completed: ${stats.completed}
• Pending: ${stats.pending}
• Total Amount: ₹${stats.totalAmount}

━━━━━━━━━━━━━━━━━━━━━
Click /start to go back
        `;
        await bot.sendMessage(chatId, reply);
    } else if (text === '📋 My Dealing History') {
        if (!stats.deals || stats.deals.length === 0) {
            return bot.sendMessage(chatId, '📋 You have no deal history yet.');
        }
        let reply = '📋 YOUR DEALING HISTORY\n━━━━━━━━━━━━━━━━━━━━━\n\n';
        for (const deal of stats.deals.slice(-10)) {
            reply += `🆔 #${deal.dealId} | ₹${deal.amount} | ${deal.role} | ${deal.status}\n`;
        }
        reply += '\n━━━━━━━━━━━━━━━━━━━━━\nClick /start to go back';
        await bot.sendMessage(chatId, reply);
    } else if (text === '⏳ My Pending Deals') {
        const pending = stats.deals.filter(d => d.status === 'pending');
        if (pending.length === 0) {
            return bot.sendMessage(chatId, '⏳ You have no pending deals.');
        }
        let reply = '⏳ YOUR PENDING DEALS\n━━━━━━━━━━━━━━━━━━━━━\n\n';
        for (const deal of pending) {
            reply += `🆔 #${deal.dealId} | ₹${deal.amount} | ${deal.role}\n`;
        }
        reply += '\n━━━━━━━━━━━━━━━━━━━━━\nClick /start to go back';
        await bot.sendMessage(chatId, reply);
    } else if (text === '🔍 View Past Deal Info') {
        if (!stats.deals || stats.deals.length === 0) {
            return bot.sendMessage(chatId, '🔍 You have no past deals.');
        }
        let reply = '🔍 PAST DEALS\n━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += 'Type /status DEAL_ID to view details\nExample: /status 409\n\n';
        for (const deal of stats.deals.slice(-5)) {
            reply += `🆔 #${deal.dealId} | ₹${deal.amount}\n`;
        }
        reply += '\n━━━━━━━━━━━━━━━━━━━━━\nClick /start to go back';
        await bot.sendMessage(chatId, reply);
    } else if (text === '🔐 Admin Panel') {
        if (!isEscrower(userId, username)) {
            return bot.sendMessage(chatId, '❌ Only promoted escrowers can access Admin Panel!');
        }
        await adminPanel(chatId, userId, username);
    }
});

// --- ESCROW COMMAND ---
bot.onText(/\/escrow (@\w+) (@\w+) (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    const chatType = msg.chat.type;

    if (chatType !== 'group' && chatType !== 'supergroup') {
        return bot.sendMessage(chatId, '❌ Use this command in a group!');
    }

    const buyer = match[1].replace('@', '');
    const seller = match[2].replace('@', '');
    const amount = match[3];
    const item = match[4];

    if (!buyer || !seller) {
        return bot.sendMessage(chatId, '❌ Both need usernames!');
    }
    if (buyer.toLowerCase() === seller.toLowerCase()) {
        return bot.sendMessage(chatId, '❌ Buyer and Seller cannot be the same person!');
    }
    if (isNaN(amount) || parseFloat(amount) <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount!');
    }

    const escrowers = getAllEscrowers();
    if (escrowers.length === 0) {
        return bot.sendMessage(chatId, '❌ No escrowers available! Contact owner.');
    }

    const dealId = generateDealId();
    const keyboard = [];
    for (const escrower of escrowers) {
        keyboard.push([{
            text: `@${escrower.username} ${escrower.hasGmail ? '🔐' : '📱'}`,
            callback_data: `select_escrow_${dealId}_${escrower.username}`
        }]);
    }
    keyboard.push([{ text: '❌ Cancel', callback_data: `cancel_deal_${dealId}` }]);

    pendingEscrowSelection[dealId] = {
        buyer,
        seller,
        amount,
        item,
        creator: username,
        creatorId: userId,
        groupId: chatId
    };

    await bot.sendMessage(chatId, `
🔐 SELECT ESCROWER
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
👤 Buyer: @${buyer}
👤 Seller: @${seller}
💰 Amount: ₹${amount}
📦 Item: ${item}

Please select an escrower:
(Only buyer or seller can select)
    `, {
        reply_markup: { inline_keyboard: keyboard }
    });
});

// --- Callback queries ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const userId = query.from.id;
    const username = query.from.username;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // Handle escrow selection
    if (data.startsWith('select_escrow_')) {
        const parts = data.split('_');
        const action = parts[0];
        const dealId = parts[2];
        const escrowerUsername = parts[3];

        if (action === 'cancel') {
            if (pendingEscrowSelection[dealId]) delete pendingEscrowSelection[dealId];
            await bot.editMessageText('❌ Deal cancelled.', { chat_id: chatId, message_id: messageId });
            return;
        }

        const pending = pendingEscrowSelection[dealId];
        if (!pending) {
            return bot.editMessageText('❌ Deal expired!', { chat_id: chatId, message_id: messageId });
        }

        if (!username) {
            return bot.answerCallbackQuery(query.id, { text: '❌ You need a username!', show_alert: true });
        }

        if (username !== pending.buyer && username !== pending.seller) {
            return bot.answerCallbackQuery(query.id, { text: '❌ Only buyer or seller can select escrower!', show_alert: true });
        }

        const escrowerData = getEscrowerData(escrowerUsername);
        if (!escrowerData) {
            return bot.editMessageText(`❌ Escrower @${escrowerUsername} not set up!`, { chat_id: chatId, message_id: messageId });
        }

        // Create deal
        const newDealId = generateDealId();
        const escrowerUserId = Object.keys(escrowerUsernameMap).find(uid => escrowerUsernameMap[uid].toLowerCase() === escrowerUsername.toLowerCase());

        escrows[newDealId] = {
            buyer: pending.buyer,
            seller: pending.seller,
            amount: pending.amount,
            item: pending.item,
            status: 'awaiting_agreement',
            escrowerId: escrowerUserId ? parseInt(escrowerUserId) : null,
            escrowerUsername,
            groupId: pending.groupId,
            timestamp: Math.floor(Date.now() / 1000),
            creator: pending.creator,
            creatorId: pending.creatorId
        };

        agreements[newDealId] = { buyerAgreed: false, sellerAgreed: false };
        releaseAgreements[newDealId] = { buyerAgreed: false, sellerAgreed: false };
        refundAgreements[newDealId] = { buyerAgreed: false, sellerAgreed: false };
        userActiveDeal[normalizeUsername(pending.buyer)] = newDealId;
        userActiveDeal[normalizeUsername(pending.seller)] = newDealId;
        delete pendingEscrowSelection[dealId];

        const formText = formatAgreement(newDealId, escrows[newDealId], 0);
        const keyboard = {
            inline_keyboard: [
                [{ text: '📋 View Form', callback_data: `view_form_${newDealId}` }]
            ]
        };
        const sentMsg = await bot.sendMessage(pending.groupId, formText, { reply_markup: keyboard });
        escrows[newDealId].messageId = sentMsg.message_id;
        await pinMessage(bot, pending.groupId, sentMsg.message_id);
        pinnedMessages[pending.groupId] = sentMsg.message_id;

        await bot.editMessageText(`✅ Escrower @${escrowerUsername} selected!\n\n🆔 Deal: #${newDealId}\nAgreement message posted in the group.`, { chat_id: chatId, message_id: messageId });

        if (escrowerUserId) {
            await bot.sendMessage(parseInt(escrowerUserId), `
🔔 NEW DEAL ASSIGNED TO YOU!

━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${newDealId}
💰 Amount: ₹${pending.amount}
📦 Item: ${pending.item}
👤 Buyer: @${pending.buyer}
👤 Seller: @${pending.seller}

⚠️ Waiting for both parties to agree.
You will be notified when payment is received.
            `);
        }
        return;
    }

    // Handle view form
    if (data.startsWith('view_form_')) {
        const dealId = data.split('_')[2];
        const escrow = escrows[dealId];
        if (!escrow) {
            return bot.answerCallbackQuery(query.id, { text: '❌ Deal not found!', show_alert: true });
        }
        const escrowData = getEscrowerData(escrow.escrowerUsername);
        const upi = escrowData ? escrowData.upi : 'Not set';
        const mode = (escrowData && escrowData.gmailKey) ? '🔐 Auto (Gmail)' : '📱 Manual (QR)';
        const formText = `
📋 DEAL FORM #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 ${dealId}
👤 @${escrow.buyer}
👤 @${escrow.seller}
💰 ₹${escrow.amount}
📦 ${escrow.item}
🔐 @${escrow.escrowerUsername}
💳 Pay to: ${upi}
📱 Mode: ${mode}
📊 ${escrow.status}
🆔 Order: ${escrow.orderId || 'N/A'}
        `;
        await bot.editMessageText(formText, { chat_id: chatId, message_id: messageId });
        return;
    }

    // Handle paid
    if (data.startsWith('paid_')) {
        const dealId = data.split('_')[1];
        await handlePaid(query, dealId);
        return;
    }

    // Handle check
    if (data.startsWith('check_')) {
        const dealId = data.split('_')[1];
        await handleCheckPayment(query, dealId);
        return;
    }

    // Handle cancel deal
    if (data.startsWith('cancel_deal_')) {
        const dealId = data.split('_')[2];
        if (pendingEscrowSelection[dealId]) {
            delete pendingEscrowSelection[dealId];
            await bot.editMessageText('❌ Deal cancelled.', { chat_id: chatId, message_id: messageId });
        }
        return;
    }

    // Handle admin panel
    if (data.startsWith('admin_') || data === 'setup_gmail' || data === 'setup_manual') {
        await handleAdminPanelButtons(query);
        return;
    }

    // Handle owner panel
    if (data === 'bot_stats' || data === 'active_deals' || data === 'escrower_list' || data === 'refresh_panel') {
        await handleOwnerPanelButtons(query);
        return;
    }

    await bot.answerCallbackQuery(query.id);
});

// --- AGREE COMMAND ---
bot.onText(/\/agree/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;

    if (!username) {
        return bot.sendMessage(chatId, '❌ You need a username!');
    }

    const dealId = findDealByUsername(username, chatId, 'awaiting_agreement');
    if (!dealId) {
        return bot.sendMessage(chatId, '❌ No pending agreement!');
    }

    const escrow = escrows[dealId];
    const usernameLower = normalizeUsername(username);
    const buyerLower = normalizeUsername(escrow.buyer);
    const sellerLower = normalizeUsername(escrow.seller);

    if (usernameLower === buyerLower) {
        if (agreements[dealId].buyerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed!');
        }
        agreements[dealId].buyerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} agreed as BUYER!`);
    } else if (usernameLower === sellerLower) {
        if (agreements[dealId].sellerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed!');
        }
        agreements[dealId].sellerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} agreed as SELLER!`);
    } else {
        return bot.sendMessage(chatId, '❌ Not part of this deal!');
    }

    const agreedCount = Object.values(agreements[dealId]).filter(Boolean).length;
    const formText = formatAgreement(dealId, escrow, agreedCount);
    const keyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    try {
        await bot.editMessageText(formText, { chat_id: chatId, message_id: escrow.messageId, reply_markup: keyboard });
    } catch (e) {}

    if (agreements[dealId].buyerAgreed && agreements[dealId].sellerAgreed) {
        await bot.sendMessage(chatId, '🎉 Both agreed! Creating deal...');
        await createDealAfterAgreement(chatId, dealId);
    }
});

async function createDealAfterAgreement(chatId, dealId) {
    const escrow = escrows[dealId];
    const escrowData = getEscrowerData(escrow.escrowerUsername);
    if (!escrowData) {
        return bot.sendMessage(chatId, `❌ Escrower @${escrow.escrowerUsername} has no setup!`);
    }

    if (escrowData.manual && escrowData.qrPhoto) {
        await sendManualQR(chatId, dealId, escrowData);
    } else if (escrowData.gmailKey) {
        await sendAutoQR(chatId, dealId, escrowData);
    } else {
        return bot.sendMessage(chatId, `❌ Escrower @${escrow.escrowerUsername} has no QR or Gmail Key!`);
    }
}

async function sendAutoQR(chatId, dealId, escrowData) {
    const escrow = escrows[dealId];
    const qrData = await api.generateQR(escrow.amount, escrowData.gmailKey);
    if (!qrData) {
        return bot.sendMessage(chatId, '❌ QR failed. Try again.');
    }
    const orderId = qrData.order_id;
    const qrImageUrl = qrData.qr_code.image_url;

    escrow.orderId = orderId;
    escrow.status = 'awaiting_payment';
    pendingPayments[orderId] = { dealId, amount: escrow.amount, timestamp: Date.now() };

    if (pinnedMessages[chatId]) {
        await unpinMessage(bot, chatId, pinnedMessages[chatId]);
    }

    const qrText = `
📱 PAYMENT QR CODE
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Pay to: ${escrowData.upi}

Scan QR to pay ₹${escrow.amount}
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ I\'ve Paid', callback_data: `paid_${dealId}` }],
            [{ text: '🔄 Check Status', callback_data: `check_${dealId}` }]
        ]
    };
    const qrMsg = await bot.sendPhoto(chatId, qrImageUrl, { caption: qrText, reply_markup: keyboard });
    escrow.qrMessageId = qrMsg.message_id;

    const formText = formatDealForm(dealId, escrow);
    const formKeyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const formMsg = await bot.sendMessage(chatId, formText, { reply_markup: formKeyboard });
    escrow.formMessageId = formMsg.message_id;
    dealFormMessages[dealId] = formMsg.message_id;
    await pinMessage(bot, chatId, formMsg.message_id);
    pinnedMessages[chatId] = formMsg.message_id;

    delete userActiveDeal[normalizeUsername(escrow.buyer)];
    delete userActiveDeal[normalizeUsername(escrow.seller)];
}

async function sendManualQR(chatId, dealId, escrowData) {
    const escrow = escrows[dealId];
    const orderId = `MANUAL-${dealId}-${Date.now()}`;
    escrow.orderId = orderId;
    escrow.status = 'awaiting_payment';
    pendingPayments[orderId] = { dealId, amount: escrow.amount, timestamp: Date.now() };

    if (pinnedMessages[chatId]) {
        await unpinMessage(bot, chatId, pinnedMessages[chatId]);
    }

    const qrText = `
📱 PAYMENT QR CODE (Manual)
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Pay to: ${escrowData.upi}

Scan QR to pay ₹${escrow.amount}
⚠️ Manual Mode: Escrower will confirm payment manually.
    `;
    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ I\'ve Paid', callback_data: `paid_${dealId}` }],
            [{ text: '🔄 Check Status', callback_data: `check_${dealId}` }]
        ]
    };
    const qrMsg = await bot.sendPhoto(chatId, escrowData.qrPhoto, { caption: qrText, reply_markup: keyboard });
    escrow.qrMessageId = qrMsg.message_id;

    const formText = formatDealForm(dealId, escrow);
    const formKeyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const formMsg = await bot.sendMessage(chatId, formText, { reply_markup: formKeyboard });
    escrow.formMessageId = formMsg.message_id;
    dealFormMessages[dealId] = formMsg.message_id;
    await pinMessage(bot, chatId, formMsg.message_id);
    pinnedMessages[chatId] = formMsg.message_id;

    delete userActiveDeal[normalizeUsername(escrow.buyer)];
    delete userActiveDeal[normalizeUsername(escrow.seller)];
}

// --- PAYMENT HANDLERS ---
async function handlePaid(query, dealId) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const username = query.from.username;

    if (!username) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Need username!', show_alert: true });
    }

    const escrow = escrows[dealId];
    if (!escrow) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Deal expired!', show_alert: true });
    }

    if (normalizeUsername(username) !== normalizeUsername(escrow.buyer)) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Only buyer can tap!', show_alert: true });
    }

    if (escrow.status !== 'awaiting_payment') {
        return bot.answerCallbackQuery(query.id, { text: `Status: ${escrow.status}`, show_alert: true });
    }

    if (verifiedPayments.has(escrow.orderId)) {
        return bot.answerCallbackQuery(query.id, { text: '✅ Already verified!', show_alert: true });
    }

    const escrowData = getEscrowerData(escrow.escrowerUsername);
    if (escrowData && escrowData.manual) {
        // Manual mode
        await bot.editMessageCaption(
            `
📱 PAYMENT QR CODE (Manual)
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🔐 Escrower: @${escrow.escrowerUsername}

⏳ Payment notification sent to escrower.
They will confirm manually.
            `,
            { chat_id: chatId, message_id: query.message.message_id }
        );
        await bot.sendMessage(escrow.escrowerId, `
🔔 PAYMENT CONFIRMATION REQUEST!

━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}

⚠️ Buyer says they have paid.
Check your UPI and confirm with /received ${dealId}
        `);
        return bot.answerCallbackQuery(query.id, { text: '📱 Payment notification sent to escrower!', show_alert: true });
    }

    if (!escrowData || !escrowData.gmailKey) {
        return bot.answerCallbackQuery(query.id, { text: '❌ Escrower has no Gmail Key!', show_alert: true });
    }

    const verification = await api.verifyPayment(escrow.orderId, escrowData.gmailKey);
    if (verification && verification.status === 'paid') {
        verifiedPayments.add(escrow.orderId);
        escrow.status = 'payment_received';
        escrow.txnId = verification.txn_id;
        escrow.payerName = verification.payer_name;
        await paymentVerifiedAndCleanup(bot, dealId, verification);
        await bot.editMessageCaption(
            `
✅ PAYMENT VERIFIED!

━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🆔 TXN: ${verification.txn_id || 'N/A'}

⏳ Escrower will release soon.
            `,
            { chat_id: chatId, message_id: query.message.message_id }
        );
    } else {
        bot.answerCallbackQuery(query.id, { text: '⏳ Payment not detected. Try again.', show_alert: true });
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ I\'ve Paid', callback_data: `paid_${dealId}` }],
                [{ text: '🔄 Check Status', callback_data: `check_${dealId}` }]
            ]
        };
        await bot.editMessageCaption(
            `
📱 PAYMENT QR CODE
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🔐 Escrower: @${escrow.escrowerUsername}

⏳ Payment not detected yet.
Please wait and try again.
            `,
            { chat_id: chatId, message_id: query.message.message_id, reply_markup: keyboard }
        );
    }
}

async function handleCheckPayment(query, dealId) {
    const chatId = query.message.chat.id;
    const escrow = escrows[dealId];
    if (!escrow) return bot.answerCallbackQuery(query.id, { text: 'Deal expired!', show_alert: true });

    if (escrow.status !== 'awaiting_payment') {
        return bot.editMessageText(`Status: ${escrow.status}`, { chat_id: chatId, message_id: query.message.message_id });
    }

    const escrowData = getEscrowerData(escrow.escrowerUsername);
    if (escrowData && escrowData.manual) {
        await bot.answerCallbackQuery(query.id, { text: '📱 Manual mode - check with escrower', show_alert: true });
        return;
    }

    if (!escrowData || !escrowData.gmailKey) {
        return bot.editMessageText('❌ Escrower has no Gmail Key!', { chat_id: chatId, message_id: query.message.message_id });
    }

    const verification = await api.verifyPayment(escrow.orderId, escrowData.gmailKey);
    if (verification && verification.status === 'paid') {
        verifiedPayments.add(escrow.orderId);
        escrow.status = 'payment_received';
        escrow.txnId = verification.txn_id;
        escrow.payerName = verification.payer_name;
        await paymentVerifiedAndCleanup(bot, dealId, verification);
        await bot.editMessageCaption(
            `
✅ PAYMENT VERIFIED!

━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🆔 TXN: ${verification.txn_id || 'N/A'}

⏳ Escrower will release soon.
            `,
            { chat_id: chatId, message_id: query.message.message_id }
        );
    } else {
        bot.answerCallbackQuery(query.id, { text: '⏳ Not detected yet.', show_alert: true });
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ I\'ve Paid', callback_data: `paid_${dealId}` }],
                [{ text: '🔄 Check Status', callback_data: `check_${dealId}` }]
            ]
        };
        await bot.editMessageCaption(
            `
📱 PAYMENT QR CODE
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer}
🔐 Escrower: @${escrow.escrowerUsername}

⏳ Payment not detected yet.
Please wait and try again.
            `,
            { chat_id: chatId, message_id: query.message.message_id, reply_markup: keyboard }
        );
    }
}

// --- RELEASE / REFUND COMMANDS ---
bot.onText(/\/release (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const dealId = match[1];

    if (!username) return bot.sendMessage(chatId, '❌ You need a username!');

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Cannot release. Status: ${escrow.status}`);
    }

    const usernameLower = normalizeUsername(username);
    const buyerLower = normalizeUsername(escrow.buyer);
    const sellerLower = normalizeUsername(escrow.seller);

    if (usernameLower !== buyerLower && usernameLower !== sellerLower) {
        return bot.sendMessage(chatId, '❌ You are not part of this deal!');
    }

    if (usernameLower === buyerLower) {
        if (releaseAgreements[dealId]?.buyerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed to release!');
        }
        releaseAgreements[dealId] = releaseAgreements[dealId] || { buyerAgreed: false, sellerAgreed: false };
        releaseAgreements[dealId].buyerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} (BUYER) agreed to RELEASE!`);
    } else if (usernameLower === sellerLower) {
        const sellerUpi = userUpi[sellerLower]?.upi;
        if (!sellerUpi) {
            return bot.sendMessage(chatId, `⚠️ @${username}, please provide your UPI ID first.\nType: /upi ${dealId} your_upi_id`);
        }
        if (releaseAgreements[dealId]?.sellerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed to release!');
        }
        releaseAgreements[dealId] = releaseAgreements[dealId] || { buyerAgreed: false, sellerAgreed: false };
        releaseAgreements[dealId].sellerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} (SELLER) agreed to RELEASE!`);
    }

    if (releaseAgreements[dealId]?.buyerAgreed && releaseAgreements[dealId]?.sellerAgreed) {
        const sellerUpi = userUpi[sellerLower]?.upi;
        await bot.sendMessage(escrow.groupId, `
✅ RELEASE AGREEMENT COMPLETE!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer} ✅
👤 Seller: @${escrow.seller} ✅
💳 Seller UPI: ${sellerUpi}

🔐 Escrower @${escrow.escrowerUsername}
Type /rlsdone ${dealId} to complete release
        `);
        await bot.sendMessage(escrow.escrowerId, `
🔔 RELEASE READY!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer} ✅
👤 Seller: @${escrow.seller} ✅
💳 Seller UPI: ${sellerUpi}

Type /rlsdone ${dealId} to complete release
        `);
    }
});

bot.onText(/\/refund (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const dealId = match[1];

    if (!username) return bot.sendMessage(chatId, '❌ You need a username!');

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Cannot refund. Status: ${escrow.status}`);
    }

    const usernameLower = normalizeUsername(username);
    const buyerLower = normalizeUsername(escrow.buyer);
    const sellerLower = normalizeUsername(escrow.seller);

    if (usernameLower !== buyerLower && usernameLower !== sellerLower) {
        return bot.sendMessage(chatId, '❌ You are not part of this deal!');
    }

    if (usernameLower === buyerLower) {
        const buyerUpi = userUpi[buyerLower]?.upi;
        if (!buyerUpi) {
            return bot.sendMessage(chatId, `⚠️ @${username}, please provide your UPI ID first.\nType: /upi ${dealId} your_upi_id`);
        }
        if (refundAgreements[dealId]?.buyerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed to refund!');
        }
        refundAgreements[dealId] = refundAgreements[dealId] || { buyerAgreed: false, sellerAgreed: false };
        refundAgreements[dealId].buyerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} (BUYER) agreed to REFUND!`);
    } else if (usernameLower === sellerLower) {
        if (refundAgreements[dealId]?.sellerAgreed) {
            return bot.sendMessage(chatId, '✅ You already agreed to refund!');
        }
        refundAgreements[dealId] = refundAgreements[dealId] || { buyerAgreed: false, sellerAgreed: false };
        refundAgreements[dealId].sellerAgreed = true;
        await bot.sendMessage(chatId, `✅ @${username} (SELLER) agreed to REFUND!`);
    }

    if (refundAgreements[dealId]?.buyerAgreed && refundAgreements[dealId]?.sellerAgreed) {
        const buyerUpi = userUpi[buyerLower]?.upi;
        await bot.sendMessage(escrow.groupId, `
✅ REFUND AGREEMENT COMPLETE!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer} ✅
👤 Seller: @${escrow.seller} ✅
💳 Buyer UPI: ${buyerUpi}

🔐 Escrower @${escrow.escrowerUsername}
Type /refunddone ${dealId} to complete refund
        `);
        await bot.sendMessage(escrow.escrowerId, `
🔔 REFUND READY!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Buyer: @${escrow.buyer} ✅
👤 Seller: @${escrow.seller} ✅
💳 Buyer UPI: ${buyerUpi}

Type /refunddone ${dealId} to complete refund
        `);
    }
});

// --- FORCE RELEASE / FORCE REFUND (Escrower Only) ---
bot.onText(/\/forcerls (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dealId = match[1];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    
    // Check if user is the escrower of this deal or owner
    if (escrow.escrowerId !== userId && !isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only the escrower or owner can force release!');
    }
    
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Cannot force release. Status: ${escrow.status}`);
    }

    // Force release - no agreement needed
    escrow.status = 'released';
    updateUserStats(escrow.buyer, dealId, escrow.amount, 'buyer', 'release');
    updateUserStats(escrow.seller, dealId, escrow.amount, 'seller', 'release');

    if (pinnedMessages[escrow.groupId]) {
        await unpinMessage(bot, escrow.groupId, pinnedMessages[escrow.groupId]);
    }

    const sellerUpi = userUpi[normalizeUsername(escrow.seller)]?.upi || 'Not set';
    const completionText = `
✅ FORCE RELEASE COMPLETED #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
📅 ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}

💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}

👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Seller UPI: ${sellerUpi}
🆔 TXN: ${escrow.txnId || 'N/A'}

⚠️ FORCE RELEASED (No agreement needed)
✅ Payment Released!

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
    const keyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const sentMsg = await bot.sendMessage(escrow.groupId, completionText, { reply_markup: keyboard });
    await pinMessage(bot, escrow.groupId, sentMsg.message_id);
    pinnedMessages[escrow.groupId] = sentMsg.message_id;

    await bot.sendMessage(escrow.buyer, `
⚠️ FORCE RELEASED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Seller: @${escrow.seller}

The escrower has force-released the payment.
    `);
    await bot.sendMessage(escrow.seller, `
🎉 PAYMENT RECEIVED (Force Release)!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
🔐 Released by: @${escrow.escrowerUsername}
⚠️ This was force-released without agreement.

🚀 Complete!
    `);

    // Notify escrower
    await bot.sendMessage(userId, `✅ Force release completed for #${dealId}`);

    // Cleanup
    delete escrows[dealId];
    delete agreements[dealId];
    delete releaseAgreements[dealId];
    delete refundAgreements[dealId];
    delete dealFormMessages[dealId];
});

bot.onText(/\/forcerfnd (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dealId = match[1];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    
    if (escrow.escrowerId !== userId && !isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only the escrower or owner can force refund!');
    }
    
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Cannot force refund. Status: ${escrow.status}`);
    }

    // Force refund - no agreement needed
    escrow.status = 'refunded';
    updateUserStats(escrow.buyer, dealId, escrow.amount, 'buyer', 'refund');
    updateUserStats(escrow.seller, dealId, escrow.amount, 'seller', 'refund');

    if (pinnedMessages[escrow.groupId]) {
        await unpinMessage(bot, escrow.groupId, pinnedMessages[escrow.groupId]);
    }

    const buyerUpi = userUpi[normalizeUsername(escrow.buyer)]?.upi || 'Not set';
    const refundText = `
↩️ FORCE REFUNDED #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
📅 ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}

💰 Amount: ₹${escrow.amount}
📦 Item: ${escrow.item}

👤 Buyer: @${escrow.buyer}
👤 Seller: @${escrow.seller}
🔐 Escrower: @${escrow.escrowerUsername}
💳 Buyer UPI: ${buyerUpi}
🆔 TXN: ${escrow.txnId || 'N/A'}

⚠️ FORCE REFUNDED (No agreement needed)
↩️ Refunded to Buyer

━━━━━━━━━━━━━━━━━━━━━
🤖 @${OWNER_USERNAME}
    `;
    const keyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const sentMsg = await bot.sendMessage(escrow.groupId, refundText, { reply_markup: keyboard });
    await pinMessage(bot, escrow.groupId, sentMsg.message_id);
    pinnedMessages[escrow.groupId] = sentMsg.message_id;

    await bot.sendMessage(escrow.buyer, `
↩️ FORCE REFUNDED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}

The escrower has force-refunded the payment.
    `);
    await bot.sendMessage(escrow.seller, `
⚠️ FORCE REFUNDED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}

The escrower has force-refunded the payment to @${escrow.buyer}.
    `);

    await bot.sendMessage(userId, `✅ Force refund completed for #${dealId}`);

    delete escrows[dealId];
    delete agreements[dealId];
    delete releaseAgreements[dealId];
    delete refundAgreements[dealId];
    delete dealFormMessages[dealId];
});

// --- ESCROWER COMPLETE COMMANDS ---
bot.onText(/\/rlsdone (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dealId = match[1];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    if (escrow.escrowerId !== userId && !isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only escrower or owner!');
    }
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Status: ${escrow.status}`);
    }

    escrow.status = 'released';
    updateUserStats(escrow.buyer, dealId, escrow.amount, 'buyer', 'release');
    updateUserStats(escrow.seller, dealId, escrow.amount, 'seller', 'release');

    if (pinnedMessages[escrow.groupId]) {
        await unpinMessage(bot, escrow.groupId, pinnedMessages[escrow.groupId]);
    }

    const sellerUpi = userUpi[normalizeUsername(escrow.seller)]?.upi || 'Not set';
    const completionText = formatReleaseComplete(dealId, escrow, sellerUpi);
    const keyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const sentMsg = await bot.sendMessage(escrow.groupId, completionText, { reply_markup: keyboard });
    await pinMessage(bot, escrow.groupId, sentMsg.message_id);
    pinnedMessages[escrow.groupId] = sentMsg.message_id;

    await bot.sendMessage(escrow.buyer, `
✅ PAYMENT RELEASED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
👤 Seller: @${escrow.seller}

🎉 Complete!
    `);
    await bot.sendMessage(escrow.seller, `
🎉 PAYMENT RECEIVED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}
🔐 Released by: @${escrow.escrowerUsername}

🚀 Complete!
    `);

    // Cleanup
    delete escrows[dealId];
    delete agreements[dealId];
    delete releaseAgreements[dealId];
    delete refundAgreements[dealId];
    delete dealFormMessages[dealId];
});

bot.onText(/\/refunddone (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dealId = match[1];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    if (escrow.escrowerId !== userId && !isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only escrower or owner!');
    }
    if (escrow.status !== 'payment_received') {
        return bot.sendMessage(chatId, `❌ Status: ${escrow.status}`);
    }

    escrow.status = 'refunded';
    updateUserStats(escrow.buyer, dealId, escrow.amount, 'buyer', 'refund');
    updateUserStats(escrow.seller, dealId, escrow.amount, 'seller', 'refund');

    if (pinnedMessages[escrow.groupId]) {
        await unpinMessage(bot, escrow.groupId, pinnedMessages[escrow.groupId]);
    }

    const buyerUpi = userUpi[normalizeUsername(escrow.buyer)]?.upi || 'Not set';
    const refundText = formatRefundComplete(dealId, escrow, buyerUpi);
    const keyboard = { inline_keyboard: [[{ text: '📋 View Form', callback_data: `view_form_${dealId}` }]] };
    const sentMsg = await bot.sendMessage(escrow.groupId, refundText, { reply_markup: keyboard });
    await pinMessage(bot, escrow.groupId, sentMsg.message_id);
    pinnedMessages[escrow.groupId] = sentMsg.message_id;

    await bot.sendMessage(escrow.buyer, `
↩️ PAYMENT REFUNDED!
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}

↩️ Refunded to you!
    `);
    await bot.sendMessage(escrow.seller, `
↩️ DEAL CANCELLED
━━━━━━━━━━━━━━━━━━━━━

🆔 Deal: #${dealId}
💰 Amount: ₹${escrow.amount}

↩️ Refunded to @${escrow.buyer}
    `);

    delete escrows[dealId];
    delete agreements[dealId];
    delete releaseAgreements[dealId];
    delete refundAgreements[dealId];
    delete dealFormMessages[dealId];
});

// --- RECEIVED COMMAND (manual) ---
bot.onText(/\/received (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const dealId = match[1];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');
    if (escrow.escrowerId !== userId && !isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only the escrower can use /received!');
    }
    if (escrow.status !== 'awaiting_payment') {
        return bot.sendMessage(chatId, `❌ Cannot confirm. Status: ${escrow.status}`);
    }
    if (verifiedPayments.has(escrow.orderId)) {
        return bot.sendMessage(chatId, '✅ Payment already verified!');
    }

    verifiedPayments.add(escrow.orderId);
    escrow.status = 'payment_received';
    await paymentVerifiedAndCleanup(bot, dealId, { txn_id: 'MANUAL', status: 'paid' });
    await bot.sendMessage(chatId, `✅ Payment manually confirmed!\n\nDeal: #${dealId}\nAmount: ₹${escrow.amount}\n\n⏳ Now type /release ${dealId} to start release`);
});

// --- STATUS COMMAND ---
bot.onText(/\/status (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const dealId = match[1];
    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');

    const escrowData = getEscrowerData(escrow.escrowerUsername);
    const upi = escrowData ? escrowData.upi : 'Not set';

    await bot.sendMessage(chatId, `
📋 DEAL STATUS #${dealId}
━━━━━━━━━━━━━━━━━━━━━

🆔 #${dealId}
📊 ${escrow.status}
💰 ₹${escrow.amount}
📦 ${escrow.item}
👤 @${escrow.buyer}
👤 @${escrow.seller}
🔐 @${escrow.escrowerUsername}
💳 Pay to: ${upi}
    `);
});

// --- ADMIN PANEL (Escrower) ---
async function adminPanel(chatId, userId, username) {
    const escrowData = getEscrowerData(username);
    const upi = escrowData ? escrowData.upi : 'Not set';
    const hasGmail = !!(escrowData && escrowData.gmailKey);
    const manual = !!(escrowData && escrowData.manual);
    const hasQr = !!(escrowData && escrowData.qrPhoto);

    const myDeals = [];
    for (const [dealId, escrow] of Object.entries(escrows)) {
        if (escrow.escrowerUsername.toLowerCase() === username.toLowerCase()) {
            myDeals.push([dealId, escrow]);
        }
    }

    let text = `
🔐 ADMIN PANEL
━━━━━━━━━━━━━━━━━━━━━

👤 @${username}
💳 UPI: ${upi}
📱 Mode: ${hasGmail ? '🔐 Auto (Gmail)' : '📱 Manual (QR)'}
${hasQr ? '✅ QR Uploaded' : '❌ No QR Uploaded'}

📊 YOUR DEALS:
• Total: ${myDeals.length}
• Pending: ${myDeals.filter(([_, e]) => e.status === 'awaiting_payment' || e.status === 'payment_received').length}
• Completed: ${myDeals.filter(([_, e]) => e.status === 'released').length}

━━━━━━━━━━━━━━━━━━━━━
    `;

    const keyboard = [];
    if (!escrowData) {
        keyboard.push([{ text: '📝 Setup UPI & QR', callback_data: 'admin_setup' }]);
    } else if (manual && !hasQr) {
        keyboard.push([{ text: '📤 Upload QR Code', callback_data: 'admin_upload_qr' }]);
    } else if (!hasGmail && !manual) {
        keyboard.push([{ text: '📤 Upload QR Code (Manual)', callback_data: 'admin_upload_qr' }]);
    }
    if (myDeals.length > 0) {
        keyboard.push([{ text: '📋 My Deals', callback_data: 'admin_my_deals' }]);
    }
    keyboard.push([{ text: '🔄 Refresh', callback_data: 'admin_refresh' }]);

    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// Admin panel callback handlers
async function handleAdminPanelButtons(query) {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const username = query.from.username;

    if (data === 'admin_setup') {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔐 With Gmail Key (Auto)', callback_data: 'setup_gmail' }],
                [{ text: '📱 Without Gmail Key (Manual QR)', callback_data: 'setup_manual' }],
                [{ text: '❌ Cancel', callback_data: 'admin_cancel' }]
            ]
        };
        await bot.editMessageText(`
🔐 ESCROWER SETUP
━━━━━━━━━━━━━━━━━━━━━

Choose how you want to receive payments:

🔐 With Gmail Key
→ Auto verification of payments
→ QR generated automatically

📱 Without Gmail Key
→ Manual verification via /received
→ Upload your own QR code

Select an option:
        `, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    } 
    else if (data === 'setup_gmail') {
        addUpiState[chatId] = { step: 'upi', mode: 'gmail' };
        await bot.editMessageText('🔐 Please enter your UPI ID (e.g., username@fam):', { chat_id: chatId, message_id: messageId });
    } 
    else if (data === 'setup_manual') {
        addUpiState[chatId] = { step: 'upi', mode: 'manual' };
        await bot.editMessageText('📱 Please enter your UPI ID (e.g., username@fam):', { chat_id: chatId, message_id: messageId });
    } 
    else if (data === 'admin_upload_qr') {
        addUpiState[chatId] = { step: 'qr_upload' };
        await bot.editMessageText('📤 Please send a photo of your UPI QR code:', { chat_id: chatId, message_id: messageId });
    } 
    else if (data === 'admin_my_deals') {
        const myDeals = [];
        for (const [dealId, escrow] of Object.entries(escrows)) {
            if (escrow.escrowerUsername.toLowerCase() === username.toLowerCase()) {
                myDeals.push([dealId, escrow]);
            }
        }
        if (myDeals.length === 0) {
            return bot.editMessageText('📭 You have no deals yet.', { chat_id: chatId, message_id: messageId });
        }
        let text = '📋 YOUR DEALS\n━━━━━━━━━━━━━━━━━━━━━\n\n';
        for (const [dealId, escrow] of myDeals) {
            text += `🆔 #${dealId} | ₹${escrow.amount} | ${escrow.status}\n`;
            text += `   Buyer: @${escrow.buyer} | Seller: @${escrow.seller}\n\n`;
        }
        const keyboard = { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'admin_refresh' }]] };
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    } 
    else if (data === 'admin_refresh') {
        await adminPanel(chatId, userId, username);
    } 
    else if (data === 'admin_cancel') {
        delete addUpiState[chatId];
        await bot.editMessageText('❌ Setup cancelled.', { chat_id: chatId, message_id: messageId });
    }
}

// ==================== PROMOTE / DEMOTE ====================
bot.onText(/\/promote @(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = match[1];

    if (!isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only owner can promote!');
    }

    // CHECK IF ALREADY PROMOTED
    let alreadyPromoted = false;

    // Check by username in escrowerUsernameMap
    for (const [uid, uname] of Object.entries(escrowerUsernameMap)) {
        if (uname.toLowerCase() === username.toLowerCase()) {
            alreadyPromoted = true;
            break;
        }
    }

    // Check by username in global.promotedByUsername
    if (!alreadyPromoted && global.promotedByUsername && global.promotedByUsername[username.toLowerCase()]) {
        alreadyPromoted = true;
    }

    if (alreadyPromoted) {
        return bot.sendMessage(chatId, `⚠️ @${username} is already an escrower!\n\nTo remove: /demote @${username}`);
    }

    // Try to find the user in the group
    let foundUserId = null;
    try {
        const member = await bot.getChatMember(chatId, `@${username}`);
        if (member && member.user) {
            foundUserId = member.user.id;
        }
    } catch (e) {
        // User not found in group
    }

    if (foundUserId) {
        promotedEscrowers.add(foundUserId);
        escrowerUsernameMap[foundUserId] = username;
        await bot.sendMessage(chatId, `✅ @${username} is now an escrower!\n\nTell them to use /start in DM and click 'Admin Panel' to setup their UPI.`);
    } else {
        global.promotedByUsername[username.toLowerCase()] = true;
        await bot.sendMessage(chatId, `✅ @${username} is now an escrower!\n\n⚠️ Ask @${username} to send /start to the bot in DM first, then promote again for full access.`);
    }
});

bot.onText(/\/demote @(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = match[1];

    if (!isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only owner can demote!');
    }

    let removed = false;
    
    for (const [uid, uname] of Object.entries(escrowerUsernameMap)) {
        if (uname.toLowerCase() === username.toLowerCase()) {
            promotedEscrowers.delete(Number(uid));
            delete escrowerUsernameMap[uid];
            removed = true;
            break;
        }
    }
    
    if (!removed && global.promotedByUsername && global.promotedByUsername[username.toLowerCase()]) {
        delete global.promotedByUsername[username.toLowerCase()];
        removed = true;
    }
    
    if (userUpi[username.toLowerCase()]) {
        delete userUpi[username.toLowerCase()];
    }
    
    if (removed) {
        await bot.sendMessage(chatId, `✅ @${username} is no longer an escrower!`);
    } else {
        await bot.sendMessage(chatId, `❌ @${username} is not an escrower!`);
    }
});

// ==================== UPI COMMAND ====================
bot.onText(/\/upi (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const dealId = match[1];
    const upiId = match[2];

    const escrow = escrows[dealId];
    if (!escrow) return bot.sendMessage(chatId, '❌ Deal not found!');

    const username = msg.from.username;
    if (!username) return bot.sendMessage(chatId, '❌ Need username!');

    const usernameLower = normalizeUsername(username);
    const buyerLower = normalizeUsername(escrow.buyer);
    const sellerLower = normalizeUsername(escrow.seller);

    if (usernameLower === sellerLower && escrow.status === 'payment_received') {
        if (!userUpi[sellerLower]) userUpi[sellerLower] = {};
        userUpi[sellerLower].upi = upiId;
        await bot.sendMessage(chatId, `✅ UPI set!\nNow type /release ${dealId}`);
    } else if (usernameLower === buyerLower && escrow.status === 'payment_received') {
        if (!userUpi[buyerLower]) userUpi[buyerLower] = {};
        userUpi[buyerLower].upi = upiId;
        await bot.sendMessage(chatId, `✅ UPI set!\nNow type /refund ${dealId}`);
    } else {
        await bot.sendMessage(chatId, '❌ Not authorized!');
    }
});

// ==================== ADDUPI COMMAND (for escrowers) ====================
bot.onText(/\/addupi/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isEscrower(userId, msg.from.username)) {
        return bot.sendMessage(chatId, '❌ Only escrowers can use this!');
    }

    addUpiState[chatId] = { step: 'upi' };
    await bot.sendMessage(chatId, 'Please enter your UPI ID (e.g., username@fam):');
});

// ==================== HANDLE ADD UPI MESSAGES ====================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Skip if in customer care state
    if (customerCareState[chatId]) return;
    
    if (!addUpiState[chatId]) return;
    if (text && text.startsWith('/')) return;

    const state = addUpiState[chatId];
    const username = msg.from.username;
    const mode = state.mode || 'gmail';

    // STEP 1: Get UPI
    if (state.step === 'upi') {
        if (!text || !text.includes('@')) {
            return bot.sendMessage(chatId, '❌ Invalid UPI! Please include @ (e.g., username@fam)');
        }
        state.upi = text;
        
        if (mode === 'gmail') {
            state.step = 'gmail';
            await bot.sendMessage(chatId, '✅ UPI set to: ' + text + '\n\n🔐 Now enter your Gmail Key:\n(Get it from: ' + API_BASE_URL + ')');
        } else {
            state.step = 'qr_upload';
            await bot.sendMessage(chatId, '✅ UPI set to: ' + text + '\n\n📤 Now please send a photo of your UPI QR code.');
        }
        return;
    }

    // STEP 2: Get Gmail Key
    if (state.step === 'gmail') {
        const upi = state.upi;
        let gmailKey = text;
        let manual = false;
        
        if (text && text.toLowerCase() === 'manual') {
            manual = true;
            gmailKey = null;
        }
        
        const usernameLower = normalizeUsername(username);
        if (!userUpi[usernameLower]) userUpi[usernameLower] = {};
        userUpi[usernameLower].upi = upi;
        userUpi[usernameLower].gmailKey = gmailKey;
        userUpi[usernameLower].manual = manual;
        
        if (manual) {
            state.step = 'qr_upload';
            await bot.sendMessage(chatId, '✅ Setup saved!\n\n📤 Now please send a photo of your UPI QR code.');
        } else {
            await bot.sendMessage(chatId, '✅ Setup complete! You can now escrow deals.\n\n' +
                '👤 Username: @' + username + '\n' +
                '💳 UPI: ' + upi + '\n' +
                '🔑 Gmail Key: ' + (gmailKey ? gmailKey.substring(0, 4) + '...' : 'Not set') + '\n' +
                '📱 Mode: 🔐 Auto (Gmail)');
            delete addUpiState[chatId];
        }
        return;
    }

    // STEP 3: Upload QR (PHOTO)
    if (state.step === 'qr_upload') {
        // If photo sent
        if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const usernameLower = normalizeUsername(username);
            if (!userUpi[usernameLower]) userUpi[usernameLower] = {};
            userUpi[usernameLower].qrPhoto = fileId;
            userUpi[usernameLower].upi = userUpi[usernameLower].upi || state.upi || 'Not set';
            userUpi[usernameLower].manual = true;
            
            await bot.sendMessage(chatId, '✅ QR code uploaded successfully! You can now escrow deals.\n\n' +
                '👤 Username: @' + username + '\n' +
                '💳 UPI: ' + (userUpi[usernameLower].upi) + '\n' +
                '📱 Mode: 📱 Manual (QR)');
            delete addUpiState[chatId];
        } 
        // If document sent (some users send QR as file)
        else if (msg.document) {
            const fileId = msg.document.file_id;
            const usernameLower = normalizeUsername(username);
            if (!userUpi[usernameLower]) userUpi[usernameLower] = {};
            userUpi[usernameLower].qrPhoto = fileId;
            userUpi[usernameLower].upi = userUpi[usernameLower].upi || state.upi || 'Not set';
            userUpi[usernameLower].manual = true;
            
            await bot.sendMessage(chatId, '✅ QR code uploaded successfully! You can now escrow deals.\n\n' +
                '👤 Username: @' + username + '\n' +
                '💳 UPI: ' + (userUpi[usernameLower].upi) + '\n' +
                '📱 Mode: 📱 Manual (QR)');
            delete addUpiState[chatId];
        }
        // If text message (asking again)
        else if (text) {
            await bot.sendMessage(chatId, '❌ Please send a photo of your QR code (not text).\n📤 Send the QR code image:');
        }
        // Unknown message type
        else {
            await bot.sendMessage(chatId, '❌ Please send a photo of your QR code.\n📤 Send the QR code image:');
        }
    }
});

// ==================== OWNER PANEL ====================
bot.onText(/\/owner_panel/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isOwner(userId)) {
        return bot.sendMessage(chatId, '❌ Only owner can access!');
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '📊 Bot Stats', callback_data: 'bot_stats' }],
            [{ text: '📋 Active Deals', callback_data: 'active_deals' }],
            [{ text: '👥 Escrowers', callback_data: 'escrower_list' }],
            [{ text: '🔄 Refresh', callback_data: 'refresh_panel' }]
        ]
    };

    await bot.sendMessage(chatId, `
👑 OWNER PANEL
━━━━━━━━━━━━━━━━━━━━━

📊 Active Deals: ${Object.keys(escrows).length}
⏳ Pending Payments: ${Object.keys(pendingPayments).length}
✅ Verified Payments: ${verifiedPayments.size}
👥 Escrowers: ${promotedEscrowers.size}
💰 Fee: 0%

Select option:
    `, { reply_markup: keyboard });
});

// Owner panel callback handlers
async function handleOwnerPanelButtons(query) {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;

    if (data === 'bot_stats') {
        const text = `
📊 BOT STATS
━━━━━━━━━━━━━━━━━━━━━

Active Deals: ${Object.keys(escrows).length}
Pending Payments: ${Object.keys(pendingPayments).length}
Verified Payments: ${verifiedPayments.size}
Escrowers: ${promotedEscrowers.size}
Fee: 0%
        `;
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } else if (data === 'active_deals') {
        if (Object.keys(escrows).length === 0) {
            return bot.editMessageText('📭 No active deals.', { chat_id: chatId, message_id: messageId });
        }
        let text = '📋 ACTIVE DEALS\n\n';
        for (const [dealId, escrow] of Object.entries(escrows).slice(0, 10)) {
            text += `━━━ #${dealId} ━━━\n💰 ₹${escrow.amount}\n📊 ${escrow.status}\n🔐 @${escrow.escrowerUsername}\n\n`;
        }
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } else if (data === 'escrower_list') {
        if (promotedEscrowers.size === 0) {
            return bot.editMessageText('👥 No escrowers.', { chat_id: chatId, message_id: messageId });
        }
        let text = '👥 ESCROWERS\n\n';
        const seen = new Set();
        for (const e of promotedEscrowers) {
            const username = escrowerUsernameMap[e] || 'Unknown';
            if (seen.has(username.toLowerCase())) continue;
            seen.add(username.toLowerCase());
            const escrowData = getEscrowerData(username);
            const upi = escrowData ? escrowData.upi : 'Not set';
            const mode = (escrowData && escrowData.gmailKey) ? '🔐 Auto' : '📱 Manual';
            text += `• @${username} | UPI: ${upi} | ${mode}\n`;
        }
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } else if (data === 'refresh_panel') {
        const keyboard = {
            inline_keyboard: [
                [{ text: '📊 Bot Stats', callback_data: 'bot_stats' }],
                [{ text: '📋 Active Deals', callback_data: 'active_deals' }],
                [{ text: '👥 Escrowers', callback_data: 'escrower_list' }],
                [{ text: '🔄 Refresh', callback_data: 'refresh_panel' }]
            ]
        };
        await bot.editMessageText(`
👑 OWNER PANEL
━━━━━━━━━━━━━━━━━━━━━

📊 Active Deals: ${Object.keys(escrows).length}
⏳ Pending Payments: ${Object.keys(pendingPayments).length}
✅ Verified Payments: ${verifiedPayments.size}
👥 Escrowers: ${promotedEscrowers.size}
💰 Fee: 0%

Select option:
        `, { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
    }
}

// ==================== EXPRESS SERVER ====================
const appExpress = express();
appExpress.get('/', (req, res) => res.send('🤖 Escrow Bot is Running!'));
appExpress.get('/health', (req, res) => res.send('OK'));

const server = appExpress.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

// ==================== START BOT ====================
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🤖 Escrow Bot Starting...');
console.log(`👑 Owner: @${OWNER_USERNAME}`);
console.log(`📊 Deal Counter: ${dealCounter}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━');

setImmediate(() => {
    checkPendingPayments(bot);
});

console.log('✅ Bot is ready!');
console.log('⏳ Listening for Telegram messages...');

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

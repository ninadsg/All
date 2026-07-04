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

// ==================== OWNER IS ALSO ESCROWER ====================
// Add owner as escrower automatically
escrowerUsernameMap[OWNER_USER_ID] = OWNER_USERNAME;
promotedEscrowers.add(OWNER_USER_ID);

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
    // Check by user ID (includes owner)
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
    
    // Owner should always be first
    if (OWNER_USERNAME) {
        const ownerData = getEscrowerData(OWNER_USERNAME);
        seenUsernames.add(OWNER_USERNAME.toLowerCase());
        escrowers.push({
            userId: OWNER_USER_ID,
            username: OWNER_USERNAME,
            upi: ownerData ? ownerData.upi : 'Not set',
            hasGmail: !!(ownerData && ownerData.gmailKey),
            manual: !!(ownerData && ownerData.manual),
            hasQr: !!(ownerData && ownerData.qrPhoto),
            isOwner: true
        });
    }
    
    for (const userId of promotedEscrowers) {
        const username = escrowerUsernameMap[userId];
        if (username && !seenUsernames.has(username.toLowerCase()) && userId !== OWNER_USER_ID) {
            seenUsernames.add(username.toLowerCase());
            const data = getEscrowerData(username);
            escrowers.push({
                userId,
                username,
                upi: data ? data.upi : 'Not set',
                hasGmail: !!(data && data.gmailKey),
                manual: !!(data && data.manual),
                hasQr: !!(data && data.qrPhoto),
                isOwner: false
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
    
    // 2x2 Grid Layout
    const keyboard = [
        [{ text: '📊 My Stats' }, { text: '📋 My Dealing History' }],
        [{ text: '⏳ My Pending Deals' }, { text: '🔍 View Past Deal Info' }]
    ];
    
    if (isEscrowerUser) {
        keyboard.push([{ text: '🔐 Admin Panel' }]);
    }
    
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
        
        const escrowers = getAllEscrowers();
        let sentCount = 0;
        
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

// --- ESCROW COMMAND (Case-insensitive) ---
bot.onText(/\/escrow @(\w+) @(\w+) (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    const chatType = msg.chat.type;

    if (chatType !== 'group' && chatType !== 'supergroup') {
        return bot.sendMessage(chatId, '❌ Use this command in a group!');
    }

    const buyer = match[1];
    const seller = match[2];
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
            text: `@${escrower.username} ${escrower.hasGmail ? '🔐' : '📱'}${escrower.isOwner ? ' 👑' : ''}`,
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

    // Handle escrow selection (case-insensitive)
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

        // Case-insensitive check
        if (username.toLowerCase() !== pending.buyer.toLowerCase() && username.toLowerCase() !== pending.seller.toLowerCase()) {
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

// --- AGREE COMMAND (Case-insensitive) ---
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

    if (agreements[dealId].buyerAgreed && agreements

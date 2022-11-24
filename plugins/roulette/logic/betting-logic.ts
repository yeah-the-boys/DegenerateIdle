import { Message } from 'discord.js';
import * as _ from 'lodash'
import { RoulettePlayState } from '@prisma/client';

import { prisma } from '../../../prisma/client';
import { SEND_DISCORD_MESSAGE } from '../discord/roulette';
import IMPORTED_BETTING_OPTIONS from './mapping/betting_options.json';
import logger from '../../../utils/logger';

// Global State Import
import { ROULETTE_ROUND, ROULETTE_PLAYERS, ROULETTE_ROUND_BETS, SET_ROULETTE_PLAYERS, ROULETTE_ROUND_CURRENT_STATUS } from './index';

// Type Imports
import { REGISTER_PLAYER } from '../../player/logic/registerPlayer';
import { RoulettePlayer } from '../../player/types/player';
import { handleFloat } from '../../../utils/utilities';

const BETTING_OPTIONS: BettingOptions = {
    ...IMPORTED_BETTING_OPTIONS,
};

type bettingDataToBeProcessed = {
    amount: number | string;
    bet: string | number;
};

interface BettingOptions {
    [key: string]: number[];
}

export async function PROCESS_ROULETTE_BET(discordMessage: Message, bettingData: bettingDataToBeProcessed): Promise<void> {

    const {
        author: { id: discordUserId },
    } = discordMessage;

    if (ROULETTE_ROUND === null) {
        await SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, 'there is currently no active roulette round, please try again soon.');
        return;
    }

    if (ROULETTE_ROUND_CURRENT_STATUS !== 'OPEN') {
        await SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, "the current round is locked, you'll have to wait for the next round.");
        return;
    }

    logger.info(`Player (ID '${discordUserId}' is placing a bet (DATA: '${JSON.stringify(bettingData)}').`);
    // Validate the bet
    const isValidBet = VALIDATE_ROULETTE_BET(bettingData);
    logger.info(`Players (ID '${discordUserId}') bet validity is '${isValidBet}'.`);
    if (isValidBet) {
        let playerData = ROULETTE_PLAYERS.find((player) => player.discordId === discordUserId);

        // Check if 'Player' data was actually in the cache
        const playerHasNotJoinedRound = playerData === undefined;
        if (playerHasNotJoinedRound) {
            // If not, go get them and cache their details...
            playerData = await JOIN_PLAYER_TO_ROULETTE_ROUND(discordUserId, discordMessage);
            logger.info(`Player (ID '${discordUserId}') has been registered against this round.`);
        }

        if (playerData) {
            // All in catcher
            if (bettingData.amount === 'all') {
                bettingData.amount = playerData.BankAccount[0].amount / 100;
            } else {
                bettingData.amount = handleFloat(bettingData.amount);
            }

            // Check if player has enough money, and write new values to memory if they do.
            if (playerData.BankAccount[0].amount < Number((bettingData.amount as number) * 100)) {
                await SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, 'you do not have enough funds to place this bet.');
                return;
            }

            await CREATE_ROULETTE_BET(playerData, bettingData);
            logger.info(`Player (ID '${discordUserId}') has had their bet registered against this round`);
        }
    } else {
        await SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, ' that was an invalid bet, please try again.');
    }
}

function VALIDATE_ROULETTE_BET(bettingData: bettingDataToBeProcessed): boolean {
    // Validate the betting amount
    // Rule: Ensure input can only be a positive integer.
    let IS_VALID_AMOUNT = true;
    let IS_ALL_IN = bettingData.amount === 'all';

    if (!IS_ALL_IN) {
        bettingData.amount = Number(bettingData.amount);
        let IS_NUMBER = typeof bettingData.amount === 'number'; // If a type other than Number, return false
        let IS_POSITIVE_NUMBER = bettingData.amount > 0; // If less than 1, return false

        IS_VALID_AMOUNT = IS_NUMBER && IS_POSITIVE_NUMBER;
    }

    // Validates the betting type
    // Rule: Ensure the betting type input matches any of the values in the VALID_XXX_BETS arrays.
    let IS_VALID_BET = true;
    const betKey = `${bettingData.bet}` as string;
    const VALID_BET = BETTING_OPTIONS[betKey as keyof BettingOptions];
    if (VALID_BET === undefined) {
        IS_VALID_BET = false;
    }

    return IS_VALID_AMOUNT && IS_VALID_BET;
}

export async function JOIN_PLAYER_TO_ROULETTE_ROUND(discordUserId: string, discordMessage: Message): Promise<RoulettePlayer | undefined> {
    if (ROULETTE_ROUND === null) {
        SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, ` there is currently no active round to bet against, try again soon.`);
    }
    try {
        let playerData = null as RoulettePlayer | null;
        playerData = (await prisma.player.findFirst({
            where: {
                discordId: discordUserId,
            },
            include : {
                BankAccount : {
                    where : {
                        type : 'SPENDINGS'
                    }
                }
            }
        })) as RoulettePlayer | null;


        if (playerData === null) {
            await SEND_DISCORD_MESSAGE({ targetChannelKey: 'BETTING_CHANNEL_ID', discordUserId, guildId: discordMessage.guildId }, ` you have now been registered, we've gifted you $1,000 to start playing with!`);
            playerData = (await REGISTER_PLAYER(discordUserId, discordMessage.author.username)) as RoulettePlayer;
        }

        playerData.previousPosition = playerData?.BankAccount[0].amount

        ROULETTE_PLAYERS.push(playerData);

        return playerData;
    } catch (error) {
        console.log(error);
        return;
    }
}

async function CREATE_ROULETTE_BET(playerData: RoulettePlayer, bettingData: bettingDataToBeProcessed) {
    try {
        const amountAsCalculableValue = Number(bettingData.amount) * 100;
        const createdRouletteBet = await prisma.roulettePlayerBet.create({
            data: {
                bet: `${bettingData.bet}`,
                amount: amountAsCalculableValue,
                state: RoulettePlayState.PENDING,
                Player: {
                    connect : {
                        id: playerData.id
                    }
                },
                RoulettePlay: {
                    connect: {
                        id: ROULETTE_ROUND?.id,
                    },
                },
            },
        })

        const hasPlayedJoinedRound = ROULETTE_PLAYERS.find((player) => player.id === playerData.id);
        if (hasPlayedJoinedRound === undefined) {
            ROULETTE_PLAYERS.push(playerData);
        }

        // Setup or adjust the counters
        let fundsAtRisk = playerData.fundsAtRisk || 0;

        // Adjust the bank account
        const spendings = _.cloneDeep(playerData.BankAccount[0]);
        spendings.amount = spendings.amount - amountAsCalculableValue;

        // Save all the things to memory
        const playersWithoutBettingPlayer = ROULETTE_PLAYERS.filter((player) => player.id !== playerData.id);
        SET_ROULETTE_PLAYERS([
            ...playersWithoutBettingPlayer,
            {
                ...playerData,
                BankAccount: [spendings],
                fundsAtRisk: fundsAtRisk + amountAsCalculableValue,
            },
        ]);

        ROULETTE_ROUND_BETS.push(createdRouletteBet);
        return createdRouletteBet;
    } catch (error) {
        console.error(error);
        return;
    }
}

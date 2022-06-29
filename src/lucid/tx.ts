import { C, Core } from "../core/mod.ts";
import {
  Address,
  Assets,
  CertificateValidator,
  Datum,
  Json,
  Label,
  Lovelace,
  MintingPolicy,
  NFTMetadata,
  NFTMetadataDetails,
  OutputData,
  PaymentKeyHash,
  PoolId,
  Redeemer,
  RewardAddress,
  SpendingValidator,
  StakeKeyHash,
  Unit,
  UnixTime,
  UTxO,
  WithdrawalValidator,
} from "../types/mod.ts";
import { assetsToValue, fromHex, utxoToCore } from "../utils/mod.ts";
import { Lucid } from "./lucid.ts";
import { TxComplete } from "./txComplete.ts";

export class Tx {
  txBuilder: Core.TransactionBuilder;
  private tasks: Function[];
  private nftMetadata: NFTMetadata = {};
  private lucid: Lucid;

  constructor(lucid: Lucid) {
    this.lucid = lucid;
    this.txBuilder = C.TransactionBuilder.new(this.lucid.txBuilderConfig);
    this.tasks = [];
    // deno-lint-ignore no-explicit-any
    this.nftMetadata = { version: 2 as any };
  }

  /**
   * Read data from utxos. These utxos are only referenced and not spent
   */
  readFrom(utxos: UTxO[]) {
    this.tasks.push(async () => {
      for (const utxo of utxos) {
        if (utxo.datumHash && !utxo.datum) {
          utxo.datum = await this.lucid.datumOf(utxo);
          // Add datum to witness set, so it can be read from validators
          const plutusData = C.PlutusData.from_bytes(fromHex(utxo.datum!));
          this.txBuilder.add_plutus_data(plutusData);
        }
        const coreUtxo = utxoToCore(utxo);
        this.txBuilder.add_reference_input(coreUtxo);
      }
    });
    return this;
  }

  /**
   * A public key or native script input
   *
   * With redeemer a plutus script input
   */
  collectFrom(utxos: UTxO[], redeemer?: Redeemer) {
    this.tasks.push(async () => {
      for (const utxo of utxos) {
        if (utxo.datumHash && !utxo.datum) {
          utxo.datum = await this.lucid.datumOf(utxo);
        }
        const coreUtxo = utxoToCore(utxo);
        this.txBuilder.add_input(
          coreUtxo,
          (redeemer as undefined) &&
            C.ScriptWitness.new_plutus_witness(
              C.PlutusWitness.new(
                C.PlutusData.from_bytes(fromHex(redeemer!)),
                utxo.datumHash && utxo.datum
                  ? C.PlutusData.from_bytes(fromHex(utxo.datum!))
                  : undefined,
                undefined,
              ),
            ),
        );
      }
    });
    return this;
  }

  /** All assets should be of the same Policy Id.
   *
   * You can chain mintAssets events together if you need to mint assets with different Policy Ids.
   *
   * If the plutus script doesn't need a redeemer, you still neeed to specifiy the empty redeemer.
   */
  mintAssets(assets: Assets, redeemer?: Redeemer) {
    const units = Object.keys(assets);
    const policyId = units[0].slice(0, 56);
    const mintAssets = C.MintAssets.new();
    units.forEach((unit) => {
      if (unit.slice(0, 56) !== policyId) {
        throw new Error(
          "Only one Policy Id allowed. You can chain multiple mintAssets events together if you need to mint assets with different Policy Ids.",
        );
      }
      mintAssets.insert(
        C.AssetName.new(fromHex(unit.slice(56))),
        C.Int.from_str(assets[unit].toString()),
      );
    });
    const scriptHash = C.ScriptHash.from_bytes(fromHex(policyId));
    this.txBuilder.add_mint(
      scriptHash,
      mintAssets,
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /**
   * Pay to a public key or native script address
   */
  payToAddress(address: Address, assets: Assets) {
    const output = C.TransactionOutput.new(
      C.Address.from_bech32(address),
      assetsToValue(assets),
    );
    this.txBuilder.add_output(output);
    return this;
  }

  /**
   * Pay to a public key or native script address with datum or scriptRef
   */
  payToAddressWithData(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets,
  ) {
    if (typeof outputData === "string") {
      outputData = { asHash: outputData };
    }

    if (outputData.asHash && outputData.inline) {
      throw new Error("Not allowed to set asHash and inline at the same time.");
    }

    const output = C.TransactionOutput.new(
      C.Address.from_bech32(address),
      assetsToValue(assets),
    );

    if (outputData.asHash) {
      const plutusData = C.PlutusData.from_bytes(fromHex(outputData.asHash));
      output.set_datum(C.Datum.new_data_hash(C.hash_plutus_data(plutusData)));
      this.txBuilder.add_plutus_data(plutusData);
    } else if (outputData.inline) {
      const plutusData = C.PlutusData.from_bytes(fromHex(outputData.inline));
      output.set_datum(C.Datum.new_data(C.Data.new(plutusData)));
    }
    const script = outputData.scriptRef;
    if (script) {
      if (script.type === "Native") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_native(
              C.NativeScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      } else if (script.type === "PlutusV1") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_plutus_v1(
              C.PlutusScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      } else if (script.type === "PlutusV2") {
        output.set_script_ref(
          C.ScriptRef.new(
            C.Script.new_plutus_v2(
              C.PlutusScript.from_bytes(fromHex(script.script)),
            ),
          ),
        );
      }
    }
    this.txBuilder.add_output(output);
    return this;
  }

  /**
   * Pay to a plutus script address with datum or scriptRef
   */
  payToContract(
    address: Address,
    outputData: Datum | OutputData,
    assets: Assets,
  ) {
    if (typeof outputData === "string") {
      outputData = { asHash: outputData };
    }

    if (!(outputData.asHash || outputData.inline)) {
      throw new Error(
        "No datum set. Script output becomes unspendable without datum.",
      );
    }

    this.payToAddressWithData(address, outputData, assets);
    return this;
  }

  /**
   * Delegate to a stake pool
   */
  delegateTo(
    rewardAddress: RewardAddress,
    poolId: PoolId,
    redeemer?: Redeemer,
  ) {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_delegation(
        C.StakeDelegation.new(credential, C.Ed25519KeyHash.from_bech32(poolId)),
      ),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  registerStake(rewardAddress: RewardAddress) {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_registration(C.StakeRegistration.new(credential)),
      undefined,
    );
    return this;
  }

  deregisterStake(rewardAddress: RewardAddress, redeemer?: Redeemer) {
    const addressDetails = this.lucid.utils.getAddressDetails(rewardAddress);
    if (
      addressDetails.address.type !== "Reward" ||
      !addressDetails.stakeCredential
    ) {
      throw new Error("Not a reward address provided.");
    }
    const credential = addressDetails.stakeCredential.type === "Key"
      ? C.StakeCredential.from_keyhash(
        C.Ed25519KeyHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      )
      : C.StakeCredential.from_scripthash(
        C.ScriptHash.from_bytes(
          fromHex(addressDetails.stakeCredential.hash),
        ),
      );

    this.txBuilder.add_certificate(
      C.Certificate.new_stake_deregistration(
        C.StakeDeregistration.new(credential),
      ),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  withdraw(
    rewardAddress: RewardAddress,
    amount: Lovelace,
    redeemer?: Redeemer,
  ) {
    this.txBuilder.add_withdrawal(
      C.RewardAddress.from_address(C.Address.from_bech32(rewardAddress))!,
      C.BigNum.from_str(amount.toString()),
      redeemer
        ? C.ScriptWitness.new_plutus_witness(
          C.PlutusWitness.new(
            C.PlutusData.from_bytes(fromHex(redeemer!)),
            undefined,
            undefined,
          ),
        )
        : undefined,
    );
    return this;
  }

  /**
   * Needs to be a public key address
   *
   * The PaymentKeyHash is taken when providing a Base, Enterprise or Pointer address
   *
   * The StakeKeyHash is taken when providing a Reward address
   */
  addSigner(address: Address | RewardAddress) {
    const addressDetails = this.lucid.utils.getAddressDetails(address);

    if (!addressDetails.paymentCredential && !addressDetails.stakeCredential) {
      throw new Error("Not a valid address.");
    }

    const credential = addressDetails.address.type === "Reward"
      ? addressDetails.stakeCredential!
      : addressDetails.paymentCredential!;

    if (credential.type === "Script") {
      throw new Error("Only key hashes are allowed as signers.");
    }

    return this.addSignerKey(credential.hash);
  }

  /**
   * Add a payment or stake key hash as a required signer of the transaction.
   */
  addSignerKey(keyHash: PaymentKeyHash | StakeKeyHash) {
    this.txBuilder.add_required_signer(
      C.Ed25519KeyHash.from_bytes(fromHex(keyHash)),
    );
    return this;
  }

  validFrom(unixTime: UnixTime) {
    const slot = this.lucid.utils.unixTimeToSlot(unixTime);
    this.txBuilder.set_validity_start_interval(
      C.BigNum.from_str(slot.toString()),
    );
    return this;
  }

  validTo(unixTime: UnixTime) {
    const slot = this.lucid.utils.unixTimeToSlot(unixTime);
    this.txBuilder.set_ttl(C.BigNum.from_str(slot.toString()));
    return this;
  }

  attachMetadata(label: Label, metadata: Json) {
    this.txBuilder.add_json_metadatum(
      C.BigNum.from_str(label.toString()),
      JSON.stringify(metadata),
    );
    return this;
  }

  /**
   * Converts strings to bytes if prefixed with **'0x'**
   */
  attachMetadataWithConversion(label: Label, metadata: Json) {
    this.txBuilder.add_json_metadatum_with_schema(
      C.BigNum.from_str(label.toString()),
      JSON.stringify(metadata),
      C.MetadataJsonSchema.BasicConversions,
    );
    return this;
  }

  /**
   * Converts strings to bytes if prefixed with **'0x'**
   *
   * Uses version 2 of CIP-0025
   *
   * You don't need to add policy id and asset name to the metadata, only add the details
   */
  attachNFTMetadata(unit: Unit, metadata: NFTMetadataDetails) {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    this.nftMetadata["0x" + policyId] = {
      ...(this.nftMetadata["0x" + policyId] || {}),
      ["0x" + assetName]: metadata,
    };

    return this;
  }

  attachSpendingValidator(spendingValidator: SpendingValidator) {
    attachScript(this, spendingValidator);
    return this;
  }

  attachMintingPolicy(mintingPolicy: MintingPolicy) {
    attachScript(this, mintingPolicy);
    return this;
  }

  attachCertificateValidator(certValidator: CertificateValidator) {
    attachScript(this, certValidator);
    return this;
  }

  attachWithdrawalValidator(withdrawalValidator: WithdrawalValidator) {
    attachScript(this, withdrawalValidator);
    return this;
  }

  /**
   * callback cannot be async
   */
  applyIf(condition: boolean, callback: (tx: Tx) => void) {
    if (condition) callback(this);
    return this;
  }

  async complete(option?: {
    changeAddress?: Address;
    datum?: { asHash?: Datum; inline?: Datum };
  }) {
    if (option?.datum?.asHash && option?.datum?.inline) {
      throw new Error("Not allowed to set asHash and inline at the same time.");
    }

    for (const task of this.tasks) {
      await task();
    }
    // Add NFT metadata
    if (Object.keys(this.nftMetadata).length > 1) {
      this.txBuilder.add_json_metadatum_with_schema(
        C.BigNum.from_str("721"),
        JSON.stringify(this.nftMetadata),
        C.MetadataJsonSchema.BasicConversions,
      );
    }

    const utxos = await this.lucid.wallet.getUtxosCore();

    const changeAddress: Core.Address = C.Address.from_bech32(
      option?.changeAddress || (await this.lucid.wallet.address()),
    );

    this.txBuilder.add_inputs_from(utxos);

    this.txBuilder.balance(
      changeAddress,
      option?.datum?.asHash
        ? C.Datum.new_data_hash(
          C.hash_plutus_data(
            C.PlutusData.from_bytes(fromHex(option.datum.asHash)),
          ),
        )
        : option?.datum?.inline
        ? C.Datum.new_data(
          C.Data.new(C.PlutusData.from_bytes(fromHex(option.datum.inline))),
        )
        : undefined,
    );
    if (option?.datum?.asHash) {
      this.txBuilder.add_plutus_data(
        C.PlutusData.from_bytes(fromHex(option.datum.asHash)),
      );
    }

    return new TxComplete(
      this.lucid,
      await this.txBuilder.construct(utxos, changeAddress),
    );
  }
}

const attachScript = (
  tx: Tx,
  script:
    | SpendingValidator
    | MintingPolicy
    | CertificateValidator
    | WithdrawalValidator,
) => {
  if (script.type === "Native") {
    return tx.txBuilder.add_native_script(
      C.NativeScript.from_bytes(fromHex(script.script)),
    );
  } else if (script.type === "PlutusV1") {
    return tx.txBuilder.add_plutus_script(
      C.PlutusScript.from_bytes(fromHex(script.script)),
    );
  } else if (script.type === "PlutusV2") {
    return tx.txBuilder.add_plutus_v2_script(
      C.PlutusScript.from_bytes(fromHex(script.script)),
    );
  }
  throw new Error("No variant matched.");
};

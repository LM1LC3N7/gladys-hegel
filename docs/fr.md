# Hegel pour Gladys

Pilotez depuis Gladys vos amplis **Hegel** dotés du contrôle IP (H95, H120,
H190, H390, H590, Röst…), en local, sans aucun cloud : allumage, veille,
volume (plafonné), sourdine et entrée.

> **Important.** Cette intégration n'a jamais été testée avec un vrai
> appareil : elle a été écrite à partir de la bibliothèque `hegel-ip-client`
> (celle qu'utilise Home Assistant) et testée avec un faux ampli seulement.
> Vos retours sont les bienvenus. Intégration non officielle, sans lien avec
> Hegel Music Systems.

## Installation

1. Branchez l'ampli sur votre réseau et donnez-lui une **adresse IP fixe**
   dans votre box (bail DHCP réservé).
2. Sur l'ampli, activez le **contrôle IP** (menu de configuration, selon le
   modèle) pour qu'il réponde aussi en veille et puisse être réveillé.
3. Dans Gladys, installez l'intégration **Hegel**, puis ouvrez sa
   configuration.
4. Saisissez les adresses IP, séparées par des virgules (par exemple
   `192.168.1.60, 192.168.1.61`). Le port de contrôle est le 50001 ; pour un
   autre, ajoutez-le : `192.168.1.60:5000`.
5. Choisissez le **plafond de volume** (40 par défaut) et, si vous le
   souhaitez, nommez les entrées.
6. Les amplis apparaissent dans l'onglet **Découverte** : créez-les.

L'intégration garde une connexion ouverte avec chaque ampli : ce qui est
changé sur l'ampli ou sa télécommande s'affiche aussitôt dans Gladys. Les états
sont aussi relus chaque minute.

## Ce que vous obtenez

| Fonction | Type Gladys                    | Remarque                                                        |
| -------- | ------------------------------ | --------------------------------------------------------------- |
| Marche   | état binaire (lecture seule)   | 1 allumé, 0 en veille ou injoignable                            |
| Allumer  | bouton                         | `-p.1`                                                          |
| Veille   | bouton                         | `-p.0`                                                          |
| Volume   | musique / volume (0 à 100)     | la valeur de l'écran de l'ampli ; commande plafonnée            |
| Sourdine | bouton (télévision / sourdine) | chaque appui lit l'état, puis règle l'inverse                   |
| Entrée   | liste déroulante               | les entrées nommées ou déjà vues ; la liste ne fait que grandir |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume tout »
d'un assistant vocal ou d'une scène ne réveille ni ne coupe votre ampli.

## Plafond de volume

Le volume d'un ampli Hegel va de 0 à 100, comme sur son écran ; Gladys affiche
la même valeur. Une commande de Gladys (tableau de bord, scène, assistant
vocal) au-dessus du **plafond** règle le plafond, jamais plus. Le plafond est
relu juste avant l'envoi : une nouvelle valeur enregistrée s'applique aussitôt.

Le volume réglé sur l'ampli lui-même (bouton, télécommande) n'est pas modifié
par l'intégration, sauf dans les deux cas où Gladys le rendrait audible :

- **Retrait de la sourdine** : si le volume de l'ampli dépasse le plafond, il
  est d'abord ramené au plafond, puis la sourdine est retirée. Si le volume ne
  peut pas être lu, rien n'est envoyé ; si l'ampli ne confirme pas la baisse,
  la sourdine est gardée.
- **Allumage** : après le réveil, le volume est relu et ramené au plafond s'il
  le dépasse (volume de démarrage de l'ampli), jusqu'à ce que l'ampli confirme
  un volume au plafond ou en dessous. Si l'ampli est lent à se réveiller,
  l'intégration vérifie encore quelques fois pendant environ 15 secondes, et
  baisse un volume signalé au-dessus du plafond pendant ce temps.

Une commande n'est réussie que si l'ampli répond la valeur demandée.

## Entrées

Le protocole donne le numéro de l'entrée choisie, pas son nom. Saisissez les
noms dans la configuration, numérotés comme dans le manuel de votre modèle,
par exemple `1=Symétrique, 2=Analogique 1, 9=Réseau`. Une entrée choisie sur
l'ampli est ajoutée à la liste sous la forme « Input N ».

## Commandes

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend 5
secondes). Une commande partie vers l'ampli sans confirmation (pas de réponse,
ou une ligne d'erreur `-e.N` de l'ampli) est signalée « envoyée, sans
confirmation » ; la ligne écrite ensuite par l'ampli montre ce qu'il a fait.
Une commande qui n'a pas pu partir est signalée « rien n'a été envoyé ». La
**veille** passe avant toutes les commandes en attente, annule un allumage
encore en attente, et part dès que la connexion est ouverte, même avant la
première lecture des états.

## Reconnexion

Un ampli qui ne répond pas (éteint, contrôle IP désactivé, débranché) affiche
sa marche à 0 et est nommé dans le statut de l'intégration. L'intégration se
reconnecte après 10 s, puis à intervalles doublés après chaque échec, jusqu'à
5 minutes. Deux relectures de suite sans réponse ferment la connexion, puis la
même reconnexion espacée s'applique. L'heure de la dernière tentative est
gardée dans `/data` : après un redémarrage de l'intégration, un ampli n'est
pas redemandé moins d'une minute après cette tentative.

## Bouton de configuration

- **Vérifier les amplis** : la connexion, la marche, le volume, la sourdine et
  l'entrée de chaque ampli, tels que connus (aucune requête de plus vers
  l'ampli), et le plafond en vigueur.

## Données et vie privée

L'intégration ne demande ni compte ni mot de passe : le contrôle IP Hegel n'en
a pas. Elle garde dans `/data/hegel.json` la liste des amplis connus (adresse,
entrées) et l'heure de la dernière tentative de connexion. Rien ne sort de
votre réseau local.

## Limites connues

- L'identité d'un ampli est son adresse : le protocole ne donne ni numéro de
  série ni modèle. Gardez une adresse IP fixe.
- Un ampli Hegel n'accepte peut-être qu'un client de contrôle IP à la fois :
  fermez les autres outils qui s'y connectent.
- Pas de réglage du volume par pas (`-v.u` / `-v.d`), ni de la luminosité ou
  du délai de mise en veille.
- Jamais testé avec un vrai appareil : les vraies réponses peuvent différer.
